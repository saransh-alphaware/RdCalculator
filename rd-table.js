// ══════════════════════════════════════════════════════════
//  rd-table.js  —  RD Financial Year Interest Breakdown
//
//  Compounding logic (UNCHANGED from existing RD engine):
//    Each instalment month: principal += deposit
//    Each month: accrue interest = principal × (annualRate/12)
//    On posting months: principal += accrued; accrued = 0
//
//  FY assignment logic (ported from fd-table.js):
//    Each monthly period is assigned to a Financial Year (Apr–Mar).
//    If a period STRADDLES the FY boundary (31 Mar / 1 Apr),
//    it is split pro-rata by calendar days:
//      interest_curr_FY = (monthlyInterest / periodDays) × daysCurrFY
//      interest_next_FY = (monthlyInterest / periodDays) × daysNextFY
//
//  ROI is passed in from script.js (already computed to 1e-15 precision).
// ══════════════════════════════════════════════════════════

// ── Date helpers ──────────────────────────────────────────

function _fmtINR(n) {
    return "₹\u00A0" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _fmtDate(d) {
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function _fyLabel(date) {
    const y = date.getFullYear(), m = date.getMonth();
    const s = m >= 3 ? y : y - 1;
    return `FY ${s}-${String(s + 1).slice(-2)}`;
}
function _fyStartDate(date) {
    const y = date.getFullYear(), m = date.getMonth();
    return new Date(m >= 3 ? y : y - 1, 3, 1);      // 1 Apr
}
function _fyEndDate(date) {
    const y = date.getFullYear(), m = date.getMonth();
    return new Date((m >= 3 ? y : y - 1) + 1, 2, 31); // 31 Mar
}

const MS_DAY = 24 * 60 * 60 * 1000;

// ── Build per-month schedule with date periods ────────────
//
//  Uses the same compounding loop as script.js / calcRDMaturity,
//  but also attaches real calendar dates to each month.

function _buildRDScheduleWithDates(depositAmt, freqMonths, investTenure, matTenure,
                                    annualRate, postFreqPerYear, startDate) {
    const mr           = annualRate / 12;
    const postInterval = 12 / postFreqPerYear;
    let p = 0, acc = 0;
    const months = [];
    let curDate = new Date(startDate);

    for (let m = 1; m <= matTenure; m++) {
        const isDepMonth  = m <= investTenure && (m === 1 || (m - 1) % freqMonths === 0);
        const isPostMonth = (m % postInterval === 0 || m === matTenure);

        if (isDepMonth) p += depositAmt;

        const pBefore  = p;
        const interest = pBefore * mr;
        acc += interest;

        // Period: [curDate, nextMonthDate - 1]
        const periodStart = new Date(curDate);
        const nextDate    = new Date(curDate);
        nextDate.setMonth(nextDate.getMonth() + 1);
        const periodEnd = new Date(nextDate);
        periodEnd.setDate(periodEnd.getDate() - 1);

        const periodDays = Math.round((periodEnd - periodStart) / MS_DAY) + 1;

        let posted = 0;
        if (isPostMonth) { posted = acc; p += acc; acc = 0; }

        months.push({
            monthNum:     m,
            periodStart:  new Date(periodStart),
            periodEnd:    new Date(periodEnd),
            periodDays,
            isDepMonth,
            isPostMonth,
            pBefore,
            interest,      // this month's share of interest (= pBefore × mr)
            posted,
            principal:    p,
        });

        curDate = new Date(nextDate);
    }
    return months;
}

// ── Group months into Financial Years ────────────────────
//
//  Mirrors fd-table.js generateFYBreakdown, adapted for RD.

function _generateRDFYBreakdown(depositAmt, freqMonths, investTenure, matTenure,
                                  annualRate, postFreqPerYear, startDate) {
    const months = _buildRDScheduleWithDates(
        depositAmt, freqMonths, investTenure, matTenure,
        annualRate, postFreqPerYear, startDate
    );

    const fyMap = {};

    function ensureFY(label, refDate) {
        if (!fyMap[label]) {
            fyMap[label] = {
                label,
                fyFrom:  new Date(_fyStartDate(refDate)),
                fyTo:    new Date(_fyEndDate(refDate)),
                entries: [],
                total:   0,
            };
        }
    }

    for (const m of months) {
        const fyS = _fyLabel(m.periodStart);
        const fyE = _fyLabel(m.periodEnd);

        ensureFY(fyS, m.periodStart);

        if (fyS === fyE) {
            // ── Whole period in one FY ──
            fyMap[fyS].entries.push({
                from:            m.periodStart,
                to:              m.periodEnd,
                monthNum:        m.monthNum,
                type:            "full",
                interest:        m.interest,
                periodDays:      m.periodDays,
                monthlyInterest: m.interest,
                isDepMonth:      m.isDepMonth,
                depositAmt:      m.isDepMonth ? depositAmt : 0,
                pBefore:         m.pBefore,
            });
            fyMap[fyS].total += m.interest;

        } else {
            // ── Straddles FY boundary (31 Mar → 1 Apr) ──
            const boundaryEnd   = _fyEndDate(m.periodStart);           // 31 Mar
            const boundaryStart = new Date(boundaryEnd);
            boundaryStart.setDate(boundaryStart.getDate() + 1);        // 1 Apr

            const dCurr = Math.round((boundaryEnd   - m.periodStart) / MS_DAY) + 1;
            const dNext = Math.round((m.periodEnd   - boundaryStart)  / MS_DAY) + 1;

            // Split by days — same formula as FD
            const ppd   = m.interest / m.periodDays;
            const iCurr = ppd * dCurr;
            const iNext = ppd * dNext;

            ensureFY(fyS, m.periodStart);
            fyMap[fyS].entries.push({
                from:            m.periodStart,
                to:              boundaryEnd,
                monthNum:        m.monthNum,
                type:            "partial-end",
                days:            dCurr,
                periodDays:      m.periodDays,
                monthlyInterest: m.interest,
                interest:        iCurr,
                isDepMonth:      m.isDepMonth,
                depositAmt:      m.isDepMonth ? depositAmt : 0,
                pBefore:         m.pBefore,
            });
            fyMap[fyS].total += iCurr;

            ensureFY(fyE, boundaryStart);
            fyMap[fyE].entries.push({
                from:            boundaryStart,
                to:              m.periodEnd,
                monthNum:        m.monthNum,
                type:            "partial-start",
                days:            dNext,
                periodDays:      m.periodDays,
                monthlyInterest: m.interest,
                interest:        iNext,
                isDepMonth:      false,   // deposit already counted in partial-end
                depositAmt:      0,
                pBefore:         m.pBefore,
            });
            fyMap[fyE].total += iNext;
        }
    }

    return Object.values(fyMap).sort((a, b) => a.fyFrom - b.fyFrom);
}

// ── Render FY Table into DOM ──────────────────────────────

function renderRDFYTable(depositAmt, freqMonths, investTenure, matTenure,
                          targetMaturity, postFreqPerYear, startStr, endStr) {
    const container = document.getElementById("fyTableWrap");
    container.innerHTML = "";

    // Re-derive annualRate at full precision (same binary-search as script.js)
    const annualRate = _findRateForFY(depositAmt, freqMonths, investTenure, matTenure, targetMaturity, postFreqPerYear);
    const startDate  = new Date(startStr);

    let fyRows;
    try {
        fyRows = _generateRDFYBreakdown(
            depositAmt, freqMonths, investTenure, matTenure,
            annualRate, postFreqPerYear, startDate
        );
    } catch (e) {
        container.innerHTML = `<p class="tbl-error">⚠️ Error: ${e.message}</p>`;
        return;
    }

    const totalInvested = depositAmt * (investTenure > 0
        ? Math.ceil(investTenure / freqMonths)   // approximate — already validated
        : 0);
    const grandTotal    = fyRows.reduce((s, r) => s + r.total, 0);
    const annualPct     = (annualRate * 100).toFixed(15);

    // ── Summary strip ──
    const summary = document.createElement("div");
    summary.className = "fy-summary";
    summary.innerHTML = `
        <div class="fy-sum-item"><span>Total Invested</span><strong>${_fmtINR(depositAmt * _countInstalments(freqMonths, investTenure))}</strong></div>
        <div class="fy-sum-item"><span>Maturity Amount</span><strong>${_fmtINR(targetMaturity)}</strong></div>
        <div class="fy-sum-item"><span>Total Interest</span><strong>${_fmtINR(grandTotal)}</strong></div>
        <div class="fy-sum-item"><span>Annual ROI</span><strong>${annualPct}%</strong></div>
    `;
    container.appendChild(summary);

    // ── Per-FY blocks ──
    fyRows.forEach(fy => {
        const block = document.createElement("div");
        block.className = "fy-block";

        block.innerHTML = `
            <div class="fy-block-header">
                <div class="fy-title">
                    <span class="fy-tag">${fy.label}</span>
                    <span class="fy-dates">${_fmtDate(fy.fyFrom)} &nbsp;→&nbsp; ${_fmtDate(fy.fyTo)}</span>
                </div>
                <div class="fy-total-badge">${_fmtINR(fy.total)}</div>
            </div>
        `;

        const tbl = document.createElement("table");
        tbl.className = "fy-tbl";
        tbl.innerHTML = `
            <thead>
                <tr>
                    <th class="sr-col">Sr.</th>
                    <th>Period (From → To)</th>
                    <th>Duration</th>
                    <th class="calc-col">Calculation</th>
                    <th class="amt-col">Interest (₹)</th>
                </tr>
            </thead>
        `;

        const tbody = document.createElement("tbody");
        let srNo = 0;

        fy.entries.forEach(e => {
            const tr = document.createElement("tr");
            let srCell, durationStr, calcStr;

            if (e.type === "full") {
                srNo++;
                srCell      = srNo;
                durationStr = "1 Month";
                // Calculation: Principal × (ROI/12)
                calcStr = `${_fmtINR(e.pBefore).replace("₹\u00A0","")} × ${(annualRate/12*100).toFixed(6)}%`;
            } else if (e.type === "partial-end") {
                tr.classList.add("row-partial", "row-partial-end");
                srCell      = "↳";
                durationStr = `${e.days} day${e.days !== 1 ? "s" : ""}`;
                // Split: (monthlyInterest ÷ periodDays) × days
                calcStr = `(${_fmtINR(e.monthlyInterest).replace("₹\u00A0","")} ÷ ${e.periodDays}) × ${e.days}`;
            } else {
                // partial-start
                tr.classList.add("row-partial", "row-partial-start");
                srCell      = "↳";
                durationStr = `${e.days} day${e.days !== 1 ? "s" : ""}`;
                calcStr = `(${_fmtINR(e.monthlyInterest).replace("₹\u00A0","")} ÷ ${e.periodDays}) × ${e.days}`;
            }

            tr.innerHTML = `
                <td class="sr-col">${srCell}</td>
                <td>${_fmtDate(e.from)} &nbsp;→&nbsp; ${_fmtDate(e.to)}</td>
                <td class="days-col">${durationStr}</td>
                <td class="calc-col">${calcStr}</td>
                <td class="amt-col">${_fmtINR(e.interest)}</td>
            `;
            tbody.appendChild(tr);
        });

        // FY total row
        const totalTr = document.createElement("tr");
        totalTr.className = "fy-total-row";
        totalTr.innerHTML = `
            <td colspan="4" class="total-label">Total Interest — ${fy.label}</td>
            <td class="amt-col">${_fmtINR(fy.total)}</td>
        `;
        tbody.appendChild(totalTr);

        tbl.appendChild(tbody);
        block.appendChild(tbl);
        container.appendChild(block);
    });

    // ── Grand total bar ──
    const gt = document.createElement("div");
    gt.className = "grand-total";
    gt.innerHTML = `<span>Grand Total Interest</span><strong>${_fmtINR(grandTotal)}</strong>`;
    container.appendChild(gt);

    container.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Internal helpers ──────────────────────────────────────

function _countInstalments(freqMonths, investTenure) {
    let count = 0;
    for (let m = 1; m <= investTenure; m++) {
        if (m === 1 || (m - 1) % freqMonths === 0) count++;
    }
    return count;
}

// Same binary search as script.js — needed here so rd-table.js is self-contained
function _calcRDMaturity(depositAmt, freqMonths, investTenure, matTenure, annualRate, postFreqPerYear) {
    const mr = annualRate / 12;
    const pi = 12 / postFreqPerYear;
    let p = 0, acc = 0;
    for (let m = 1; m <= matTenure; m++) {
        if (m <= investTenure && (m === 1 || (m - 1) % freqMonths === 0)) p += depositAmt;
        acc += p * mr;
        if (m % pi === 0 || m === matTenure) { p += acc; acc = 0; }
    }
    return p;
}

function _findRateForFY(depositAmt, freqMonths, investTenure, matTenure, target, postFreqPerYear) {
    let lo = 0, hi = 5, tol = 1e-15;
    for (let i = 0; i < 400; i++) {
        const mid = (lo + hi) / 2;
        if (_calcRDMaturity(depositAmt, freqMonths, investTenure, matTenure, mid, postFreqPerYear) > target)
            hi = mid;
        else
            lo = mid;
        if (hi - lo < tol) break;
    }
    return (lo + hi) / 2;
}