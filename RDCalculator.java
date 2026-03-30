import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.*;

// ══════════════════════════════════════════════════════════════════════════════
//  RDCalculator.java  —  Standalone RD ROI & Financial Year Interest Calculator
//
//  COMPOUNDING LOGIC:
//    - investTenure  = 1 + (numberOfInstalments - 1) * depositFrequency
//      (the month number in which the LAST deposit lands)
//    - matTenure     = total months between startDate and endDate
//    - Each month m (1 → matTenure):
//        • If it is a deposit month  → principal += depositAmount
//        • Monthly interest accrued  = principal × (annualRate / 12)
//        • On a posting month        → principal += accrued ; accrued = 0
//    - Deposit months: m === 1  OR  (m - 1) % depositFrequency === 0,
//      provided m <= investTenure
//    - Posting months: m % postInterval === 0  OR  m === matTenure
//      where postInterval = 12 / interestPostingPerYear
//
//  ROI:
//    Binary-search (400 iterations, tolerance 1e-15) to find the annual rate
//    (as a decimal) that makes the compounding engine return exactly the
//    given maturity amount.
//
//  FY SPLIT:
//    Financial year runs 1 Apr → 31 Mar.
//    If a monthly period straddles the FY boundary, it is split pro-rata
//    by calendar days:
//      interest_curr_FY = (monthlyInterest / periodDays) × daysCurrFY
//      interest_next_FY = (monthlyInterest / periodDays) × daysNextFY
// ══════════════════════════════════════════════════════════════════════════════

public class RDCalculator {

    // ─────────────────────────────────────────────────────────────────────────
    //  Inner class: TermPeriod (replaces _calculateTermPeriod return object)
    // ─────────────────────────────────────────────────────────────────────────
    static class TermPeriod {
        int months;
        int days;

        TermPeriod(int months, int days) {
            this.months = months;
            this.days   = days;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Inner class: DateResult (replaces _maturityMonthsFromDates return object)
    // ─────────────────────────────────────────────────────────────────────────
    static class DateResult {
        int        totalMonths;
        int        extraDays;
        TermPeriod term;

        DateResult(int totalMonths, int extraDays, TermPeriod term) {
            this.totalMonths = totalMonths;
            this.extraDays   = extraDays;
            this.term        = term;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Inner class: MonthEntry (replaces the per-month push object)
    // ─────────────────────────────────────────────────────────────────────────
    static class MonthEntry {
        int       monthNum;
        LocalDate periodStart;
        LocalDate periodEnd;
        int       periodDays;
        boolean   isDepositMonth;
        boolean   isPostingMonth;
        double    principalBeforeInterest;
        double    interest;
        double    posted;
        double    accruedAfter;
        double    principal;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Inner class: FYEntry (replaces fyMap value objects)
    // ─────────────────────────────────────────────────────────────────────────
    static class FYEntry {
        String    label;
        LocalDate fyFrom;
        LocalDate fyTo;
        double    total;

        FYEntry(String label, LocalDate fyFrom, LocalDate fyTo) {
            this.label  = label;
            this.fyFrom = fyFrom;
            this.fyTo   = fyTo;
            this.total  = 0.0;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Inner class: InterestFinancialEntry (final output per FY)
    // ─────────────────────────────────────────────────────────────────────────
    static class InterestFinancialEntry {
        String fromDate;
        String toDate;
        double interest;

        InterestFinancialEntry(String fromDate, String toDate, double interest) {
            this.fromDate = fromDate;
            this.toDate   = toDate;
            this.interest = interest;
        }

        @Override
        public String toString() {
            return String.format(
                "{ fromDate: \"%s\", toDate: \"%s\", interest: %.2f }",
                fromDate, toDate, interest
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Inner class: RDResult (final return value of calculateRD)
    // ─────────────────────────────────────────────────────────────────────────
    static class RDResult {
        double                       depositAmount;
        int                          depositFrequency;
        double                       maturityAmount;
        String                       startDate;
        String                       endDate;
        String                       roi;               // full-precision string
        int                          numberOfInstalments;
        int                          term;              // total months (maturity tenure)
        double                       totalInvested;
        double                       totalInterest;
        int                          interestPosting;
        List<InterestFinancialEntry> interestFinancial;

        @Override
        public String toString() {
            StringBuilder sb = new StringBuilder();
            sb.append("{\n");
            sb.append(String.format("  depositAmount      : %.2f%n",  depositAmount));
            sb.append(String.format("  depositFrequency   : %d%n",    depositFrequency));
            sb.append(String.format("  maturityAmount     : %.2f%n",  maturityAmount));
            sb.append(String.format("  startDate          : \"%s\"%n",startDate));
            sb.append(String.format("  endDate            : \"%s\"%n",endDate));
            sb.append(String.format("  roi                : \"%s\"%n",roi));
            sb.append(String.format("  numberOfInstalments: %d%n",    numberOfInstalments));
            sb.append(String.format("  term               : %d%n",    term));
            sb.append(String.format("  totalInvested      : %.2f%n",  totalInvested));
            sb.append(String.format("  totalInterest      : %.2f%n",  totalInterest));
            sb.append(String.format("  interestPosting    : %d%n",    interestPosting));
            sb.append("  interestFinancial  : [\n");
            for (InterestFinancialEntry e : interestFinancial) {
                sb.append("    ").append(e).append("\n");
            }
            sb.append("  ]\n}");
            return sb.toString();
        }
    }


    // =========================================================================
    //  SECTION 1 — Date & Term Helpers
    // =========================================================================

    private static final DateTimeFormatter ISO_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    /**
     * Formats a LocalDate to "YYYY-MM-DD" string.
     * Mirrors: _toISODateStr(date)
     */
    static String toISODateStr(LocalDate date) {
        return date.format(ISO_FMT);
    }

    /**
     * Calculates the number of whole months (and leftover days) between two date
     * strings. Mirrors _calculateTermPeriod from the JS source exactly.
     *
     * Returns TermPeriod { months, days }
     */
    static TermPeriod calculateTermPeriod(String date1Str, String date2Str) {
        LocalDate d1 = LocalDate.parse(date1Str, ISO_FMT);
        LocalDate d2 = LocalDate.parse(date2Str, ISO_FMT);

        LocalDate start = d1;
        LocalDate end   = d2;
        if (start.isAfter(end)) {
            LocalDate tmp = start;
            start = end;
            end   = tmp;
        }

        // isEndOfMonth: end.getDate() === last day of end's month
        boolean isEndOfMonth = end.getDayOfMonth() ==
            end.withDayOfMonth(end.lengthOfMonth()).getDayOfMonth();

        // Special case: Jan 1 → Feb 28/29 of same year → 2 months, 0 days
        if (
            start.getDayOfMonth() == 1 && start.getMonthValue() == 1 &&
            end.getMonthValue()   == 2 && isEndOfMonth &&
            start.getYear()       == end.getYear()
        ) {
            return new TermPeriod(2, 0);
        }

        // Special case: first-of-month → last-of-month → exact whole months
        if (isEndOfMonth && start.getDayOfMonth() == 1) {
            int m = (end.getMonthValue() - start.getMonthValue()) +
                    (end.getYear()       - start.getYear()) * 12 + 1;
            return new TermPeriod(m, 0);
        }

        // 30-31 day span → treat as 1 month
        long daysDiff = ChronoUnit.DAYS.between(start, end);  // same as Math.ceil((end-start)/MS_PER_DAY)
        if (daysDiff >= 30 && daysDiff <= 31) {
            return new TermPeriod(1, 0);
        }

        int months = (end.getMonthValue() - start.getMonthValue()) +
                     (end.getYear()       - start.getYear()) * 12;
        int days   = end.getDayOfMonth() - start.getDayOfMonth() + 1;

        if (days <= 1) {
            // expected = start shifted forward by `months` months
            LocalDate expected = start.plusMonths(months);
            long diff = ChronoUnit.DAYS.between(expected, end);   // (end - expected) / MS_PER_DAY

            if (diff >= -1 && diff <= 0) {
                days = 0;
            } else if (days <= 0) {
                // Borrow a month: prev = last day of month before `end`
                LocalDate prev = end.withDayOfMonth(1).minusDays(1); // last day of previous month
                days   += prev.getDayOfMonth();
                months -= 1;
            }
        }

        return new TermPeriod(months, days);
    }

    /**
     * Returns the total whole months between startStr and endStr.
     * This becomes the matTenure (loop upper bound).
     * Mirrors: _maturityMonthsFromDates(startStr, endStr)
     */
    static DateResult maturityMonthsFromDates(String startStr, String endStr) {
        TermPeriod term = calculateTermPeriod(startStr, endStr);
        return new DateResult(term.months, term.days, term);
    }


    // =========================================================================
    //  SECTION 2 — Financial Year Helpers
    // =========================================================================

    /**
     * Returns FY label, e.g. "FY 2025-26" for any date in that year.
     * Mirrors: _fyLabel(date)
     */
    static String fyLabel(LocalDate date) {
        int y = date.getYear();
        int m = date.getMonthValue();          // 1-based; April = 4
        int startYear = (m >= 4) ? y : y - 1;
        String shortNext = String.valueOf(startYear + 1);
        shortNext = shortNext.substring(shortNext.length() - 2); // last 2 chars
        return "FY " + startYear + "-" + shortNext;
    }

    /**
     * Returns the start date (1 Apr) of the FY that contains `date`.
     * Mirrors: _fyStartDate(date)
     */
    static LocalDate fyStartDate(LocalDate date) {
        int y = date.getYear();
        int m = date.getMonthValue();
        int startYear = (m >= 4) ? y : y - 1;
        return LocalDate.of(startYear, 4, 1);
    }

    /**
     * Returns the end date (31 Mar) of the FY that contains `date`.
     * Mirrors: _fyEndDate(date)
     */
    static LocalDate fyEndDate(LocalDate date) {
        int y = date.getYear();
        int m = date.getMonthValue();
        int startYear = (m >= 4) ? y : y - 1;
        return LocalDate.of(startYear + 1, 3, 31);
    }


    // =========================================================================
    //  SECTION 3 — RD Compounding Engine
    // =========================================================================

    /**
     * Core RD compounding loop.
     * Mirrors: _calcRDMaturity(...)
     *
     * @param depositAmount          Amount of each instalment
     * @param depositFrequency       Gap in months between instalments (1, 3, 4, 6, 12)
     * @param investTenure           Month number of the LAST deposit
     * @param matTenure              Total months until maturity
     * @param annualRate             Annual interest rate as a DECIMAL (e.g. 0.105)
     * @param interestPostingPerYear How many times per year interest posts (1, 2, 4, 12)
     * @return Maturity amount
     */
    static double calcRDMaturity(double depositAmount, int depositFrequency,
                                  int investTenure, int matTenure,
                                  double annualRate, int interestPostingPerYear) {
        double monthlyRate  = annualRate / 12.0;
        double postInterval = 12.0 / interestPostingPerYear;  // months between posting events
        double principal    = 0;
        double accrued      = 0;

        for (int m = 1; m <= matTenure; m++) {
            // Is this a deposit month?
            boolean isDepositMonth = (m <= investTenure) &&
                                     (m == 1 || (m - 1) % depositFrequency == 0);
            if (isDepositMonth) {
                principal += depositAmount;
            }

            // Accrue interest on the principal AFTER this month's deposit
            accrued += principal * monthlyRate;

            // Is this a posting month?
            boolean isPostingMonth = (m % postInterval == 0 || m == matTenure);
            if (isPostingMonth) {
                principal += accrued;
                accrued    = 0;
            }
        }

        return principal;
    }

    /**
     * Binary search for the annual rate (decimal) that produces exactly targetMaturity.
     * Converges to tolerance 1e-15 within 400 iterations.
     * Mirrors: _findAnnualRate(...)
     */
    static double findAnnualRate(double depositAmount, int depositFrequency,
                                  int investTenure, int matTenure,
                                  double targetMaturity, int interestPostingPerYear) {
        double lo        = 0;
        double hi        = 5;         // 500% annual rate as upper bound — more than enough
        double tolerance = 1e-15;

        for (int i = 0; i < 400; i++) {
            double mid = (lo + hi) / 2.0;
            if (calcRDMaturity(depositAmount, depositFrequency, investTenure, matTenure,
                               mid, interestPostingPerYear) > targetMaturity) {
                hi = mid;
            } else {
                lo = mid;
            }
            if (hi - lo < tolerance) break;
        }

        return (lo + hi) / 2.0;
    }


    // =========================================================================
    //  SECTION 4 — Month Schedule Builder (with real calendar dates)
    // =========================================================================

    /**
     * Builds a per-month schedule, attaching real calendar dates to every period.
     * Each month's period is [periodStart, periodEnd] where:
     *   periodStart = first day of that compounding month
     *   periodEnd   = one day before the next month's start (last day of this period)
     *
     * Mirrors: _buildMonthSchedule(...)
     *
     * @return List of MonthEntry objects
     */
    static List<MonthEntry> buildMonthSchedule(double depositAmount, int depositFrequency,
                                                int investTenure, int matTenure,
                                                double annualRate, int interestPostingPerYear,
                                                LocalDate startDate) {
        double monthlyRate  = annualRate / 12.0;
        double postInterval = 12.0 / interestPostingPerYear;
        double principal    = 0;
        double accrued      = 0;

        List<MonthEntry> months  = new ArrayList<>();
        LocalDate        curDate = startDate;

        for (int m = 1; m <= matTenure; m++) {
            boolean isDepositMonth = (m <= investTenure) &&
                                     (m == 1 || (m - 1) % depositFrequency == 0);
            boolean isPostingMonth = (m % postInterval == 0 || m == matTenure);

            if (isDepositMonth) {
                principal += depositAmount;
            }

            double principalBeforeInterest = principal;
            double interest                = principalBeforeInterest * monthlyRate;
            accrued += interest;

            // Calendar dates for this period
            LocalDate periodStart    = curDate;
            LocalDate nextMonthDate  = curDate.plusMonths(1);
            LocalDate periodEnd      = nextMonthDate.minusDays(1);

            long periodDays = ChronoUnit.DAYS.between(periodStart, periodEnd) + 1;

            double posted = 0;
            if (isPostingMonth) {
                posted     = accrued;
                principal += accrued;
                accrued    = 0;
            }

            MonthEntry entry                    = new MonthEntry();
            entry.monthNum                      = m;
            entry.periodStart                   = periodStart;
            entry.periodEnd                     = periodEnd;
            entry.periodDays                    = (int) periodDays;
            entry.isDepositMonth                = isDepositMonth;
            entry.isPostingMonth                = isPostingMonth;
            entry.principalBeforeInterest       = principalBeforeInterest;
            entry.interest                      = interest;
            entry.posted                        = posted;
            entry.accruedAfter                  = accrued;
            entry.principal                     = principal;

            months.add(entry);
            curDate = nextMonthDate;
        }

        return months;
    }


    // =========================================================================
    //  SECTION 5 — Financial Year Interest Breakdown
    // =========================================================================

    /**
     * Groups the monthly schedule into Financial Years (April–March).
     * Periods straddling the FY boundary (31 Mar / 1 Apr) are split pro-rata
     * by calendar days.
     *
     * Mirrors: _generateFYBreakdown(...)
     *
     * @return List of FYEntry objects sorted chronologically: { label, fyFrom, fyTo, total }
     */
    static List<FYEntry> generateFYBreakdown(double depositAmount, int depositFrequency,
                                              int investTenure, int matTenure,
                                              double annualRate, int interestPostingPerYear,
                                              LocalDate startDate) {
        List<MonthEntry> months = buildMonthSchedule(
            depositAmount, depositFrequency, investTenure, matTenure,
            annualRate, interestPostingPerYear, startDate
        );

        // fyMap: key = FY label → FYEntry { label, fyFrom, fyTo, total }
        // Use LinkedHashMap to maintain insertion order (sorted later)
        Map<String, FYEntry> fyMap = new LinkedHashMap<>();

        for (MonthEntry m : months) {
            String fyLabelStart = fyLabel(m.periodStart);
            String fyLabelEnd   = fyLabel(m.periodEnd);

            if (fyLabelStart.equals(fyLabelEnd)) {
                // ── Entire period falls within one FY ──
                ensureFY(fyMap, fyLabelStart, m.periodStart);
                fyMap.get(fyLabelStart).total += m.interest;

            } else {
                // ── Period straddles the FY boundary (31 Mar → 1 Apr) ──

                // Last day of the current FY (31 Mar)
                LocalDate boundaryEnd   = fyEndDate(m.periodStart);
                // First day of the next FY (1 Apr)
                LocalDate boundaryStart = boundaryEnd.plusDays(1);

                // Days in each side of the split
                long daysCurrFY = ChronoUnit.DAYS.between(m.periodStart, boundaryEnd)   + 1;
                long daysNextFY = ChronoUnit.DAYS.between(boundaryStart, m.periodEnd)   + 1;

                // Pro-rata interest split
                double interestPerDay = m.interest / m.periodDays;
                double interestCurrFY = interestPerDay * daysCurrFY;
                double interestNextFY = interestPerDay * daysNextFY;

                ensureFY(fyMap, fyLabelStart, m.periodStart);
                fyMap.get(fyLabelStart).total += interestCurrFY;

                ensureFY(fyMap, fyLabelEnd, boundaryStart);
                fyMap.get(fyLabelEnd).total += interestNextFY;
            }
        }

        // Return sorted chronologically by fyFrom
        List<FYEntry> result = new ArrayList<>(fyMap.values());
        result.sort(Comparator.comparing(e -> e.fyFrom));
        return result;
    }

    /**
     * Helper: ensures an FY entry exists in the map.
     * Mirrors the inner ensureFY() function in _generateFYBreakdown.
     */
    private static void ensureFY(Map<String, FYEntry> fyMap, String label, LocalDate refDate) {
        if (!fyMap.containsKey(label)) {
            fyMap.put(label, new FYEntry(label, fyStartDate(refDate), fyEndDate(refDate)));
        }
    }


    // =========================================================================
    //  SECTION 6 — Main Public Method
    // =========================================================================

    /**
     * calculateRD
     *
     * Computes RD ROI and financial year-wise interest breakdown.
     *
     * @param depositAmount         Amount per instalment (₹)
     * @param depositFrequency      Months between instalments
     *                              1=Monthly, 3=Every 3 Months,
     *                              4=Every 4 Months, 6=Half-yearly, 12=Yearly
     * @param numberOfInstalments   Total number of instalments
     * @param startDate             First instalment date "YYYY-MM-DD"
     * @param endDate               Maturity date "YYYY-MM-DD"
     * @param maturityAmount        Expected maturity payout (₹)
     * @param interestPosting       Interest posting frequency per year
     *                              1=Yearly, 2=Half-Yearly, 4=Quarterly, 12=Monthly
     * @return RDResult object
     */
    public static RDResult calculateRD(double depositAmount, int depositFrequency,
                                        int numberOfInstalments, String startDate,
                                        String endDate, double maturityAmount,
                                        int interestPosting) {

        // ── 1. Input validation ──────────────────────────────────
        if (depositAmount <= 0) {
            throw new IllegalArgumentException("depositAmount must be a positive number.");
        }
        Set<Integer> validFrequencies = new HashSet<>(Arrays.asList(1, 3, 4, 6, 12));
        if (!validFrequencies.contains(depositFrequency)) {
            throw new IllegalArgumentException("depositFrequency must be one of: 1, 3, 4, 6, 12.");
        }
        if (numberOfInstalments < 1) {
            throw new IllegalArgumentException("numberOfInstalments must be at least 1.");
        }
        if (startDate == null || endDate == null) {
            throw new IllegalArgumentException("startDate and endDate are required.");
        }
        LocalDate startDateObj = LocalDate.parse(startDate, ISO_FMT);
        LocalDate endDateObj   = LocalDate.parse(endDate,   ISO_FMT);
        if (!startDateObj.isBefore(endDateObj)) {
            throw new IllegalArgumentException("endDate must be after startDate.");
        }
        if (maturityAmount <= 0) {
            throw new IllegalArgumentException("maturityAmount must be a positive number.");
        }
        Set<Integer> validPostings = new HashSet<>(Arrays.asList(1, 2, 4, 12));
        if (!validPostings.contains(interestPosting)) {
            throw new IllegalArgumentException("interestPosting must be one of: 1, 2, 4, 12.");
        }

        // ── 2. Derive tenures ────────────────────────────────────
        //
        //  investTenure = month number at which the LAST deposit is made.
        //  Formula: first deposit is month 1, subsequent deposits are at
        //           month 1 + depositFrequency, 1 + 2*depositFrequency, ...
        //  So the n-th deposit lands at month: 1 + (n-1) * depositFrequency
        //  For n = numberOfInstalments:
        //    investTenure = 1 + (numberOfInstalments - 1) * depositFrequency
        int investTenure = 1 + (numberOfInstalments - 1) * depositFrequency;

        //  matTenure = total whole months between startDate and endDate.
        DateResult dateResult = maturityMonthsFromDates(startDate, endDate);
        int        matTenure  = dateResult.totalMonths;

        if (matTenure < investTenure) {
            throw new IllegalArgumentException(
                "Maturity date yields only " + matTenure + " months but " +
                investTenure + " months are needed for " + numberOfInstalments +
                " instalments at " + depositFrequency + "-month frequency. " +
                "Please extend the endDate."
            );
        }

        double totalInvested = depositAmount * numberOfInstalments;
        if (maturityAmount <= totalInvested) {
            throw new IllegalArgumentException(
                "maturityAmount (" + maturityAmount + ") must be greater than " +
                "totalInvested (" + totalInvested + ")."
            );
        }

        // ── 3. Find annual ROI via binary search ─────────────────
        double annualRate = findAnnualRate(
            depositAmount, depositFrequency, investTenure, matTenure,
            maturityAmount, interestPosting
        );

        String roiPercent = String.valueOf(annualRate * 100);   // full precision string

        // ── 4. Derived summary values ────────────────────────────
        double totalInterest = maturityAmount - totalInvested;

        // ── 5. FY breakdown ──────────────────────────────────────
        List<FYEntry> fyRows = generateFYBreakdown(
            depositAmount, depositFrequency, investTenure, matTenure,
            annualRate, interestPosting, startDateObj
        );

        List<InterestFinancialEntry> interestFinancial = new ArrayList<>();
        for (FYEntry fy : fyRows) {
            double rounded = Math.round(fy.total * 100.0) / 100.0;  // toFixed(2) equivalent
            interestFinancial.add(new InterestFinancialEntry(
                toISODateStr(fy.fyFrom),
                toISODateStr(fy.fyTo),
                rounded
            ));
        }

        // ── 6. Return result ─────────────────────────────────────
        RDResult result               = new RDResult();
        result.depositAmount          = depositAmount;
        result.depositFrequency       = depositFrequency;
        result.maturityAmount         = maturityAmount;
        result.startDate              = startDate;
        result.endDate                = endDate;
        result.roi                    = roiPercent;
        result.numberOfInstalments    = numberOfInstalments;
        result.term                   = matTenure;
        result.totalInvested          = totalInvested;
        result.totalInterest          = Math.round(totalInterest * 100.0) / 100.0;
        result.interestPosting        = interestPosting;
        result.interestFinancial      = interestFinancial;

        return result;
    }


    // =========================================================================
    //  SECTION 7 — Example Usage (main method)
    // =========================================================================

    public static void main(String[] args) {
        RDResult result = calculateRD(
            50000,          // depositAmount
            12,             // depositFrequency
            3,              // numberOfInstalments
            "2026-03-18",   // startDate
            "2031-03-17",   // endDate
            300000,         // maturityAmount
            1               // interestPosting
        );

        System.out.println(result);
    }
}