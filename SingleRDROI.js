// ══════════════════════════════════════════════════════════════════════════════
//  rd-calculator.js  —  Standalone RD ROI & Financial Year Interest Calculator
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
//
//  USAGE:
//    const result = calculateRD({
//        depositAmount      : 500,
//        depositFrequency   : 1,      // 1=monthly, 3=every3mo, 4=every4mo, 6=half-yearly, 12=yearly
//        numberOfInstalments: 48,
//        startDate          : "2026-03-18",
//        endDate            : "2030-03-17",
//        maturityAmount     : 29647,
//        interestPosting    : 1,      // times per year: 1=yearly, 2=half-yearly, 4=quarterly, 12=monthly
//    });
// ══════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 1 — Date & Term Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Formats a Date object to "YYYY-MM-DD" string.
 */
function _toISODateStr(date) {
    const y   = date.getFullYear();
    const mo  = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${y}-${mo}-${day}`;
}

/**
 * Calculates the number of whole months (and leftover days) between two date
 * strings.  Mirrors the original calculateTermPeriod logic from script.js.
 *
 * Returns { months: number, days: number }
 */
function _calculateTermPeriod(date1Str, date2Str) {
    const d1 = new Date(date1Str);
    const d2 = new Date(date2Str);

    if (isNaN(d1) || isNaN(d2)) {
        throw new Error("Invalid date(s) provided.");
    }

    let start = new Date(d1);
    let end   = new Date(d2);
    if (start > end) { const tmp = start; start = end; end = tmp; }

    const isEndOfMonth = end.getDate() ===
        new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();

    // Special case: Jan 1 → Feb 28/29 of same year → 2 months, 0 days
    if (
        start.getDate() === 1 && start.getMonth() === 0 &&
        end.getMonth()  === 1 && isEndOfMonth &&
        start.getFullYear() === end.getFullYear()
    ) {
        return { months: 2, days: 0 };
    }

    // Special case: first-of-month → last-of-month → exact whole months
    if (isEndOfMonth && start.getDate() === 1) {
        const m = (end.getMonth() - start.getMonth()) +
                  (end.getFullYear() - start.getFullYear()) * 12 + 1;
        return { months: m, days: 0 };
    }

    // 30-31 day span → treat as 1 month
    const daysDiff = Math.ceil((end - start) / MS_PER_DAY);
    if (daysDiff >= 30 && daysDiff <= 31) {
        return { months: 1, days: 0 };
    }

    let months = (end.getMonth() - start.getMonth()) +
                 (end.getFullYear() - start.getFullYear()) * 12;
    let days   = end.getDate() - start.getDate() + 1;

    if (days <= 1) {
        const expected = new Date(
            start.getFullYear(),
            start.getMonth() + months,
            start.getDate()
        );
        const diff = (end - expected) / MS_PER_DAY;
        if (diff >= -1 && diff <= 0) {
            days = 0;
        } else if (days <= 0) {
            // Borrow a month
            const prev = new Date(end.getFullYear(), end.getMonth(), 0);
            days += prev.getDate();
            months -= 1;
        }
    }

    return { months, days };
}

/**
 * Returns the total whole months between startStr and endStr.
 * This becomes the matTenure (loop upper bound).
 */
function _maturityMonthsFromDates(startStr, endStr) {
    const term = _calculateTermPeriod(startStr, endStr);
    return { totalMonths: term.months, extraDays: term.days, term };
}


// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 2 — Financial Year Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns FY label, e.g. "FY 2025-26" for any date in that year. */
function _fyLabel(date) {
    const y = date.getFullYear();
    const m = date.getMonth();
    const startYear = m >= 3 ? y : y - 1;          // April = month index 3
    return `FY ${startYear}-${String(startYear + 1).slice(-2)}`;
}

/** Returns the start date (1 Apr) of the FY that contains `date`. */
function _fyStartDate(date) {
    const y = date.getFullYear();
    const m = date.getMonth();
    return new Date(m >= 3 ? y : y - 1, 3, 1);     // month index 3 = April
}

/** Returns the end date (31 Mar) of the FY that contains `date`. */
function _fyEndDate(date) {
    const y = date.getFullYear();
    const m = date.getMonth();
    return new Date((m >= 3 ? y : y - 1) + 1, 2, 31); // month index 2 = March
}


// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 3 — RD Compounding Engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Core RD compounding loop.
 *
 * @param {number} depositAmount       - Amount of each instalment
 * @param {number} depositFrequency    - Gap in months between instalments (1, 3, 4, 6, 12)
 * @param {number} investTenure        - Month number of the LAST deposit
 * @param {number} matTenure           - Total months until maturity
 * @param {number} annualRate          - Annual interest rate as a DECIMAL (e.g. 0.105)
 * @param {number} interestPostingPerYear - How many times per year interest posts (1, 2, 4, 12)
 * @returns {number} Maturity amount
 */
function _calcRDMaturity(depositAmount, depositFrequency, investTenure, matTenure,
                          annualRate, interestPostingPerYear) {
    const monthlyRate  = annualRate / 12;
    const postInterval = 12 / interestPostingPerYear;   // months between posting events
    let principal = 0;
    let accrued   = 0;

    for (let m = 1; m <= matTenure; m++) {
        // Is this a deposit month?
        const isDepositMonth = (m <= investTenure) &&
                               (m === 1 || (m - 1) % depositFrequency === 0);
        if (isDepositMonth) {
            principal += depositAmount;
        }

        // Accrue interest on the principal AFTER this month's deposit
        accrued += principal * monthlyRate;

        // Is this a posting month?
        const isPostingMonth = (m % postInterval === 0 || m === matTenure);
        if (isPostingMonth) {
            principal += accrued;
            accrued    = 0;
        }
    }

    return principal;
}

/**
 * Binary search for the annual rate (decimal) that produces exactly `targetMaturity`.
 * Converges to tolerance 1e-15 within 400 iterations.
 */
function _findAnnualRate(depositAmount, depositFrequency, investTenure, matTenure,
                          targetMaturity, interestPostingPerYear) {
    let lo  = 0;
    let hi  = 5;        // 500% annual rate as upper bound — more than enough
    const tolerance = 1e-15;

    for (let i = 0; i < 400; i++) {
        const mid = (lo + hi) / 2;
        if (_calcRDMaturity(depositAmount, depositFrequency, investTenure, matTenure,
                            mid, interestPostingPerYear) > targetMaturity) {
            hi = mid;
        } else {
            lo = mid;
        }
        if (hi - lo < tolerance) break;
    }

    return (lo + hi) / 2;
}


// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 4 — Month Schedule Builder (with real calendar dates)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a per-month schedule, attaching real calendar dates to every period.
 * Each month's period is [periodStart, periodEnd] where:
 *   periodStart = first day of that compounding month
 *   periodEnd   = one day before the next month's start  (i.e. last day of this period)
 *
 * @returns {Array} Array of month objects
 */
function _buildMonthSchedule(depositAmount, depositFrequency, investTenure, matTenure,
                               annualRate, interestPostingPerYear, startDate) {
    const monthlyRate  = annualRate / 12;
    const postInterval = 12 / interestPostingPerYear;
    let principal = 0;
    let accrued   = 0;

    const months  = [];
    let curDate   = new Date(startDate);

    for (let m = 1; m <= matTenure; m++) {
        const isDepositMonth = (m <= investTenure) &&
                               (m === 1 || (m - 1) % depositFrequency === 0);
        const isPostingMonth = (m % postInterval === 0 || m === matTenure);

        if (isDepositMonth) {
            principal += depositAmount;
        }

        const principalBeforeInterest = principal;
        const interest = principalBeforeInterest * monthlyRate;
        accrued += interest;

        // Calendar dates for this period
        const periodStart = new Date(curDate);

        const nextMonthDate = new Date(curDate);
        nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);

        const periodEnd = new Date(nextMonthDate);
        periodEnd.setDate(periodEnd.getDate() - 1);

        const periodDays = Math.round((periodEnd - periodStart) / MS_PER_DAY) + 1;

        let posted = 0;
        if (isPostingMonth) {
            posted     = accrued;
            principal += accrued;
            accrued    = 0;
        }

        months.push({
            monthNum:    m,
            periodStart: new Date(periodStart),
            periodEnd:   new Date(periodEnd),
            periodDays,
            isDepositMonth,
            isPostingMonth,
            principalBeforeInterest,
            interest,           // this month's interest contribution
            posted,             // amount posted to principal this month (0 if not a posting month)
            accruedAfter: accrued,
            principal,          // running principal after this month's operations
        });

        curDate = new Date(nextMonthDate);
    }

    return months;
}


// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 5 — Financial Year Interest Breakdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups the monthly schedule into Financial Years (April–March).
 * Periods straddling the FY boundary (31 Mar / 1 Apr) are split pro-rata
 * by calendar days.
 *
 * @returns {Array} Array of FY objects sorted chronologically:
 *   { label, fyFrom, fyTo, total }
 */
function _generateFYBreakdown(depositAmount, depositFrequency, investTenure, matTenure,
                               annualRate, interestPostingPerYear, startDate) {
    const months = _buildMonthSchedule(
        depositAmount, depositFrequency, investTenure, matTenure,
        annualRate, interestPostingPerYear, startDate
    );

    // fyMap: key = FY label → { label, fyFrom, fyTo, total }
    const fyMap = {};

    function ensureFY(label, refDate) {
        if (!fyMap[label]) {
            fyMap[label] = {
                label,
                fyFrom: new Date(_fyStartDate(refDate)),
                fyTo:   new Date(_fyEndDate(refDate)),
                total:  0,
            };
        }
    }

    for (const m of months) {
        const fyLabelStart = _fyLabel(m.periodStart);
        const fyLabelEnd   = _fyLabel(m.periodEnd);

        if (fyLabelStart === fyLabelEnd) {
            // ── Entire period falls within one FY ──
            ensureFY(fyLabelStart, m.periodStart);
            fyMap[fyLabelStart].total += m.interest;

        } else {
            // ── Period straddles the FY boundary (31 Mar → 1 Apr) ──

            // Last day of the current FY (31 Mar)
            const boundaryEnd   = _fyEndDate(m.periodStart);
            // First day of the next FY (1 Apr)
            const boundaryStart = new Date(boundaryEnd);
            boundaryStart.setDate(boundaryStart.getDate() + 1);

            // Days in each side of the split
            const daysCurrFY = Math.round((boundaryEnd   - m.periodStart) / MS_PER_DAY) + 1;
            const daysNextFY = Math.round((m.periodEnd   - boundaryStart) / MS_PER_DAY) + 1;

            // Pro-rata interest split
            const interestPerDay = m.interest / m.periodDays;
            const interestCurrFY = interestPerDay * daysCurrFY;
            const interestNextFY = interestPerDay * daysNextFY;

            ensureFY(fyLabelStart, m.periodStart);
            fyMap[fyLabelStart].total += interestCurrFY;

            ensureFY(fyLabelEnd, boundaryStart);
            fyMap[fyLabelEnd].total += interestNextFY;
        }
    }

    // Return sorted chronologically
    return Object.values(fyMap).sort((a, b) => a.fyFrom - b.fyFrom);
}


// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 6 — Main Public Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * calculateRD
 *
 * Computes RD ROI and financial year-wise interest breakdown.
 *
 * @param {Object} params
 * @param {number} params.depositAmount         - Amount per instalment (₹)
 * @param {number} params.depositFrequency      - Months between instalments
 *                                                 1=Monthly, 3=Every 3 Months,
 *                                                 4=Every 4 Months, 6=Half-yearly, 12=Yearly
 * @param {number} params.numberOfInstalments   - Total number of instalments
 * @param {string} params.startDate             - First instalment date "YYYY-MM-DD"
 * @param {string} params.endDate               - Maturity date "YYYY-MM-DD"
 * @param {number} params.maturityAmount        - Expected maturity payout (₹)
 * @param {number} params.interestPosting       - Interest posting frequency per year
 *                                                 1=Yearly, 2=Half-Yearly, 4=Quarterly, 12=Monthly
 *
 * @returns {Object} Result object (see JSDoc below)
 */
function calculateRD({
    depositAmount,
    depositFrequency,
    numberOfInstalments,
    startDate,
    endDate,
    maturityAmount,
    interestPosting,
}) {
    // ── 1. Input validation ──────────────────────────────────
    if (!depositAmount || depositAmount <= 0) {
        throw new Error("depositAmount must be a positive number.");
    }
    if (!depositFrequency || ![1, 3, 4, 6, 12].includes(depositFrequency)) {
        throw new Error("depositFrequency must be one of: 1, 3, 4, 6, 12.");
    }
    if (!numberOfInstalments || numberOfInstalments < 1) {
        throw new Error("numberOfInstalments must be at least 1.");
    }
    if (!startDate || !endDate) {
        throw new Error("startDate and endDate are required.");
    }
    if (new Date(startDate) >= new Date(endDate)) {
        throw new Error("endDate must be after startDate.");
    }
    if (!maturityAmount || maturityAmount <= 0) {
        throw new Error("maturityAmount must be a positive number.");
    }
    if (!interestPosting || ![1, 2, 4, 12].includes(interestPosting)) {
        throw new Error("interestPosting must be one of: 1, 2, 4, 12.");
    }

    // ── 2. Derive tenures ────────────────────────────────────
    //
    //  investTenure = month number at which the LAST deposit is made.
    //  Formula: first deposit is month 1, subsequent deposits are at
    //           month 1 + depositFrequency, 1 + 2*depositFrequency, ...
    //  So the n-th deposit lands at month: 1 + (n-1) * depositFrequency
    //  For n = numberOfInstalments:
    //    investTenure = 1 + (numberOfInstalments - 1) * depositFrequency
    const investTenure = 1 + (numberOfInstalments - 1) * depositFrequency;

    //  matTenure = total whole months between startDate and endDate.
    const dateResult = _maturityMonthsFromDates(startDate, endDate);
    const matTenure  = dateResult.totalMonths;

    if (matTenure < investTenure) {
        throw new Error(
            `Maturity date yields only ${matTenure} months but ${investTenure} months ` +
            `are needed for ${numberOfInstalments} instalments at ${depositFrequency}-month frequency. ` +
            `Please extend the endDate.`
        );
    }

    const totalInvested = depositAmount * numberOfInstalments;
    if (maturityAmount <= totalInvested) {
        throw new Error(
            `maturityAmount (${maturityAmount}) must be greater than totalInvested (${totalInvested}).`
        );
    }

    // ── 3. Find annual ROI via binary search ─────────────────
    const annualRate = _findAnnualRate(
        depositAmount, depositFrequency, investTenure, matTenure,
        maturityAmount, interestPosting
    );

    const roiPercent = (annualRate * 100).toString(); // full precision string

    // ── 4. Derived summary values ────────────────────────────
    const totalInterest = maturityAmount - totalInvested;

    // ── 5. FY breakdown ──────────────────────────────────────
    const startDateObj = new Date(startDate);

    const fyRows = _generateFYBreakdown(
        depositAmount, depositFrequency, investTenure, matTenure,
        annualRate, interestPosting, startDateObj
    );

    const interestFinancial = fyRows.map(fy => ({
        fromDate : _toISODateStr(fy.fyFrom),
        toDate   : _toISODateStr(fy.fyTo),
        interest : parseFloat(fy.total.toFixed(2)),
    }));

    // ── 6. Return result ─────────────────────────────────────
    return {
        depositAmount,
        depositFrequency,
        maturityAmount,
        startDate,
        endDate,
        roi             : roiPercent,
        numberOfInstalments,
        term            : matTenure,         // total months (maturity tenure)
        totalInvested,
        totalInterest   : parseFloat(totalInterest.toFixed(2)),
        interestPosting,
        interestFinancial,
    };
}


// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 7 — Example Usage
// ─────────────────────────────────────────────────────────────────────────────
//
//  Uncomment the block below to run a quick test in Node.js:
//    node rd-calculator.js
//
const result = calculateRD({
    depositAmount      : 50000,
    depositFrequency   : 12,
    numberOfInstalments: 3,
    startDate          : "2026-03-18",
    endDate            : "2031-03-17",
    maturityAmount     : 300000,
    interestPosting    : 1,
});
console.log(JSON.stringify(result, null, 4));


// Export for Node.js / CommonJS environments (ignored in browser)
if (typeof module !== "undefined" && module.exports) {
    module.exports = { calculateRD };
}
