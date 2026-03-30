// ══════════════════════════════════════════════════════════
//  script.js  —  RD ROI Calculator
//  Core logic: binary-search ROI, date helpers, UI wiring
// ══════════════════════════════════════════════════════════

// ── Formatting ────────────────────────────────────────────

function fmtINR(n) {
    return "₹\u00A0" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function toISODateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// ── Date validation ───────────────────────────────────────

function isStrictlyValidDate(str) {
    if (!str) return false;
    const [y, mo, d] = str.split("-").map(Number);
    if (!y || !mo || !d) return false;
    if (mo < 1 || mo > 12 || d < 1) return false;
    const last = new Date(y, mo, 0).getDate();
    if (d > last) return false;
    const p = new Date(str);
    if (isNaN(p)) return false;
    return p.getFullYear() === y && p.getMonth() + 1 === mo && p.getDate() === d;
}

function setFieldError(inputEl, msg) {
    inputEl.classList.add("input-error");
    const wrap = inputEl.closest(".field") || inputEl.parentElement;
    let hint = wrap.querySelector(".field-hint");
    if (!hint) {
        hint = document.createElement("span");
        hint.className = "field-hint error-hint";
        inputEl.insertAdjacentElement("afterend", hint);
    }
    hint.textContent = msg;
    hint.className = "field-hint error-hint";
}

function clearFieldError(inputEl) {
    inputEl.classList.remove("input-error");
    const wrap = inputEl.closest(".field") || inputEl.parentElement;
    const hint = wrap.querySelector(".field-hint");
    if (hint) hint.remove();
}

function showError(msg) {
    const box = document.getElementById("errorBox");
    box.textContent = "⚠️  " + msg;
    box.classList.remove("hidden");
}
function hideError() {
    document.getElementById("errorBox").classList.add("hidden");
}

// ── Term calculation (months + leftover days) ─────────────
//  Same contract as FD's calculateTermPeriod

function calculateTermPeriod(date1Str, date2Str) {
    const d1 = new Date(date1Str), d2 = new Date(date2Str);
    if (isNaN(d1) || isNaN(d2)) return "Invalid date(s) provided.";
    let start = new Date(d1), end = new Date(d2);
    if (start > end) [start, end] = [end, start];

    const isEndOfMonth = end.getDate() === new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();

    // Jan 1 → Feb 28/29
    if (start.getDate() === 1 && start.getMonth() === 0 &&
        end.getMonth() === 1 && isEndOfMonth &&
        start.getFullYear() === end.getFullYear()) {
        return { months: 2, days: 0 };
    }

    // First of month → last of month
    if (isEndOfMonth && start.getDate() === 1) {
        const m = end.getMonth() - start.getMonth() +
                  (end.getFullYear() - start.getFullYear()) * 12 + 1;
        return { months: m, days: 0 };
    }

    const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    if (daysDiff >= 30 && daysDiff <= 31) return { months: 1, days: 0 };

    let months = end.getMonth() - start.getMonth() +
                 (end.getFullYear() - start.getFullYear()) * 12;
    let days = end.getDate() - start.getDate() + 1;

    if (days <= 1) {
        const expected = new Date(start.getFullYear(), start.getMonth() + months, start.getDate());
        const diff = (end - expected) / (1000 * 60 * 60 * 24);
        if (diff >= -1 && diff <= 0) {
            days = 0;
        } else if (days <= 0) {
            const prev = new Date(end.getFullYear(), end.getMonth(), 0);
            days += prev.getDate();
            months -= 1;
        }
    }
    return { months, days };
}

function termToYears(term) { return term.months / 12 + term.days / 365; }

function formatTermLabel(term) {
    const yrs = Math.floor(term.months / 12), mons = term.months % 12;
    const parts = [];
    if (yrs  > 0) parts.push(`${yrs} yr${yrs  > 1 ? "s" : ""}`);
    if (mons > 0) parts.push(`${mons} mo${mons > 1 ? "s" : ""}`);
    if (term.days > 0) parts.push(`${term.days} day${term.days > 1 ? "s" : ""}`);
    return parts.length ? parts.join(" ") : "0 mos";
}

// ── RD Compounding Engine ─────────────────────────────────
//
//  Exactly mirrors the existing compounding logic:
//  Each instalment month: principal += deposit
//  Each month: accrue interest = principal × (annualRate/12)
//  On posting months: principal += accrued; accrued = 0
//
//  NOTE: annualRate here is a DECIMAL (e.g. 0.07 for 7%)
//
function calcRDMaturity(depositAmt, freqMonths, investTenure, matTenure, annualRate, postFreqPerYear) {
    const mr = annualRate / 12;
    const postInterval = 12 / postFreqPerYear;
    let p = 0, acc = 0;
    for (let m = 1; m <= matTenure; m++) {
        if (m <= investTenure && (m === 1 || (m - 1) % freqMonths === 0)) p += depositAmt;
        acc += p * mr;
        if (m % postInterval === 0 || m === matTenure) { p += acc; acc = 0; }
    }
    return p;
}

// Binary search — returns annual rate as DECIMAL, converges to 1e-15
function findAnnualRate(depositAmt, freqMonths, investTenure, matTenure, target, postFreqPerYear) {
    let lo = 0, hi = 5, tol = 1e-15;
    for (let i = 0; i < 400; i++) {
        const mid = (lo + hi) / 2;
        if (calcRDMaturity(depositAmt, freqMonths, investTenure, matTenure, mid, postFreqPerYear) > target)
            hi = mid;
        else
            lo = mid;
        if (hi - lo < tol) break;
    }
    return (lo + hi) / 2;
}

// ── Derive maturity tenure from start + end dates ─────────
//
//  Returns total whole months between startDate and endDate.
//  This is the "matTenure" used in the loop.

function maturityMonthsFromDates(startStr, endStr) {
    const term = calculateTermPeriod(startStr, endStr);
    if (typeof term === "string") return null;
    // Total months (whole) — fractional days handled in FY table
    return { totalMonths: term.months, extraDays: term.days, term };
}

// ── Date-based month schedule ─────────────────────────────
//
//  Returns array of { monthNum, periodStart, periodEnd, monthlyInterest, deposit }
//  Used by the month table AND by the FY breakdown.

function buildRDMonthSchedule(depositAmt, freqMonths, investTenure, matTenure, annualRate, postFreqPerYear, startDate) {
    const mr = annualRate / 12;
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

        // Period: from curDate, end = next month same day - 1
        const periodStart = new Date(curDate);
        const nextDate = new Date(curDate);
        nextDate.setMonth(nextDate.getMonth() + 1);
        const periodEnd = new Date(nextDate);
        periodEnd.setDate(periodEnd.getDate() - 1);

        let posted = 0;
        if (isPostMonth) { posted = acc; p += acc; acc = 0; }

        months.push({
            monthNum: m,
            periodStart: new Date(periodStart),
            periodEnd:   new Date(periodEnd),
            isDepMonth,
            isPostMonth,
            pBefore,
            interest,
            posted,
            accAfter: acc,  // accrued AFTER this month (0 if just posted)
            depositAmt: isDepMonth ? depositAmt : 0,
            principal: p,
        });

        curDate = new Date(nextDate);
    }

    return months;
}

// ── DOM helpers ───────────────────────────────────────────

const startInput = document.getElementById("startDate");
const endInput   = document.getElementById("endDate");

function validateDateFields() {
    const sv = startInput.value, ev = endInput.value;
    let ok = true;
    if (sv && !isStrictlyValidDate(sv)) {
        setFieldError(startInput, "Invalid date.");
        ok = false;
    } else { clearFieldError(startInput); }
    if (ev && !isStrictlyValidDate(ev)) {
        setFieldError(endInput, "Invalid date.");
        ok = false;
    } else { clearFieldError(endInput); }
    if (ok && sv && ev && new Date(sv) >= new Date(ev)) {
        setFieldError(endInput, "End date must be after start date.");
        ok = false;
    }
    return ok;
}

// Auto-update the maturity note when dates change
function syncMaturityNote() {
    const note = document.getElementById("maturityNote");
    if (!startInput.value || !endInput.value) {
        note.textContent = "Maturity period will be calculated";
        return;
    }
    if (!validateDateFields()) { note.textContent = "Fix date errors above"; return; }
    const result = maturityMonthsFromDates(startInput.value, endInput.value);
    if (!result) { note.textContent = "Unable to calculate"; return; }
    const { term } = result;
    note.textContent = `= ${formatTermLabel(term)} total tenure`;
}

startInput.addEventListener("change", () => { validateDateFields(); syncMaturityNote(); updateTenureNote(); });
endInput.addEventListener("change",   () => { validateDateFields(); syncMaturityNote(); });
startInput.addEventListener("input",  () => { if (!startInput.value) clearFieldError(startInput); });
endInput.addEventListener("input",    () => { if (!endInput.value)   clearFieldError(endInput); });

document.getElementById("numInstalments").addEventListener("input", updateTenureNote);
document.getElementById("depositFrequency").addEventListener("change", updateTenureNote);

function updateTenureNote() {
    const numInst    = parseInt(document.getElementById("numInstalments").value) || 1;
    const freqMonths = parseInt(document.getElementById("depositFrequency").value);
    const investTenure = 1 + (numInst - 1) * freqMonths;
    document.getElementById("tenureNote").textContent = `= last deposit at month ${investTenure}`;

    // If we have a start date, show the actual last-deposit date too
    if (startInput.value && isStrictlyValidDate(startInput.value)) {
        const lastDepDate = new Date(startInput.value);
        lastDepDate.setMonth(lastDepDate.getMonth() + investTenure - 1);
        document.getElementById("tenureNote").textContent =
            `= last deposit at month ${investTenure} (${lastDepDate.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })})`;
    }
}

// ── Shared input validation ───────────────────────────────

function getValidatedInputs() {
    const depositAmt = parseFloat(document.getElementById("depositAmount").value);
    const numInst    = parseInt(document.getElementById("numInstalments").value);
    const freqMonths = parseInt(document.getElementById("depositFrequency").value);
    const target     = parseFloat(document.getElementById("maturityAmount").value);
    const postFreq   = parseInt(document.getElementById("postingFrequency").value);

    if (isNaN(depositAmt) || depositAmt <= 0) { showError("Enter a valid Deposit Amount."); return null; }
    if (isNaN(numInst)    || numInst < 1)     { showError("Enter a valid Number of Instalments."); return null; }
    if (isNaN(target)     || target <= 0)     { showError("Enter a valid Maturity Amount."); return null; }

    // Dates required
    if (!startInput.value) { showError("Please enter a Start Date."); return null; }
    if (!endInput.value)   { showError("Please enter a Maturity/End Date."); return null; }
    if (!isStrictlyValidDate(startInput.value)) { setFieldError(startInput, "Invalid date."); showError("Start Date is invalid."); return null; }
    if (!isStrictlyValidDate(endInput.value))   { setFieldError(endInput,   "Invalid date."); showError("End Date is invalid."); return null; }
    if (new Date(startInput.value) >= new Date(endInput.value)) {
        setFieldError(endInput, "End date must be after start date.");
        showError("End Date must be after Start Date.");
        return null;
    }

    const dateResult = maturityMonthsFromDates(startInput.value, endInput.value);
    if (!dateResult) { showError("Could not calculate tenure from dates."); return null; }

    const investTenure = 1 + (numInst - 1) * freqMonths;
    const matTenure    = dateResult.totalMonths;

    if (matTenure < investTenure) {
        showError(`Maturity date gives only ${matTenure} months, but ${investTenure} months are needed for ${numInst} instalments at ${freqMonths}-month frequency. Please extend the End Date.`);
        return null;
    }

    const totalInvested = depositAmt * numInst;
    if (target <= totalInvested) {
        showError(`Maturity Amount (${fmtINR(target)}) must be greater than Total Invested (${fmtINR(totalInvested)}).`);
        return null;
    }

    return {
        depositAmt, numInst, freqMonths, target, postFreq,
        investTenure, matTenure,
        term: dateResult.term,
        startStr: startInput.value,
        endStr:   endInput.value,
    };
}

// ── Main: Calculate ROI ───────────────────────────────────

function runCalculator() {
    hideError();
    const v = getValidatedInputs();
    if (!v) return;

    const { depositAmt, numInst, freqMonths, target, postFreq, investTenure, matTenure, term, startStr, endStr } = v;

    const annualRate = findAnnualRate(depositAmt, freqMonths, investTenure, matTenure, target, postFreq);
    const monthlyRate = annualRate / 12;
    // 15 decimal places
    const annualPct  = (annualRate  * 100).toFixed(15);
    const monthlyPct = (monthlyRate * 100).toFixed(15);

    const freqLabels = { 1:"Monthly", 3:"Every 3 Months", 4:"Every 4 Months", 6:"Every 6 Months", 12:"Yearly" };
    const postLabels = { 1:"Yearly", 2:"Half-Yearly", 4:"Quarterly", 12:"Monthly" };

    const totalInvested = depositAmt * numInst;
    const totalInterest = target - totalInvested;

    // Show summary panel
    document.getElementById("summaryPanel").classList.remove("hidden");

    document.getElementById("statsRow").innerHTML = `
        <div class="stat blue">
            <div class="stat-label">Total Invested</div>
            <div class="stat-value">${fmtINR(totalInvested)}</div>
            <div class="stat-sub">${numInst} instalment${numInst > 1 ? "s" : ""} × ${fmtINR(depositAmt)}</div>
        </div>
        <div class="stat green">
            <div class="stat-label">Total Interest</div>
            <div class="stat-value">${fmtINR(totalInterest)}</div>
            <div class="stat-sub">Earned over ${formatTermLabel(term)}</div>
        </div>
        <div class="stat purple">
            <div class="stat-label">Maturity Amount</div>
            <div class="stat-value">${fmtINR(target)}</div>
            <div class="stat-sub">Payout: ${new Date(endStr).toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}</div>
        </div>
        <div class="stat amber">
            <div class="stat-label">Annual ROI</div>
            <div class="stat-value" style="font-size:15px">${annualPct}%</div>
            <div class="stat-sub">${monthlyPct.substring(0,10)}…% p.m.</div>
        </div>
        <div class="stat rose">
            <div class="stat-label">Last Deposit / Maturity</div>
            <div class="stat-value">M${investTenure} / M${matTenure}</div>
            <div class="stat-sub">${numInst} inst. · ${freqLabels[freqMonths]}</div>
        </div>
    `;

    document.getElementById("infoBox").innerHTML = `
        <p>
            <strong>${numInst} instalment${numInst > 1 ? "s" : ""}</strong> of <strong>${fmtINR(depositAmt)}</strong>
            paid <strong>${freqLabels[freqMonths]}</strong> — last deposit at <strong>Month ${investTenure}</strong>,
            total invested <strong>${fmtINR(totalInvested)}</strong>.
            Corpus grows untouched until <strong>${new Date(endStr).toLocaleDateString("en-IN",{day:"2-digit",month:"long",year:"numeric"})}</strong>.
            Interest posts <strong>${postLabels[postFreq]}</strong> throughout.
        </p>
        <div class="formula-line">Annual ROI: ${annualPct}% · Monthly: ${monthlyPct.substring(0,12)}…% · Posting: ${postLabels[postFreq]} · Tenure: ${formatTermLabel(term)}</div>
    `;

    // Month-by-month table
    const startDate = new Date(startStr);
    const months    = buildRDMonthSchedule(depositAmt, freqMonths, investTenure, matTenure, annualRate, postFreq, startDate);

    document.getElementById("breakdownPanel").classList.remove("hidden");
    document.getElementById("tableNote").textContent =
        `${numInst} instalments ${freqLabels[freqMonths]}  ·  Last deposit: Month ${investTenure}  ·  Posting: ${postLabels[postFreq]}  ·  Maturity: ${new Date(endStr).toLocaleDateString("en-IN")}`;

    const fmtD = d => d.toLocaleDateString("en-IN", { day:"2-digit", month:"2-digit", year:"numeric" });

    let rows = "";
    let totalInt = 0;
    for (const m of months) {
        totalInt += m.interest;
        const isMat = m.monthNum === matTenure;

        let rowClass = "";
        if (isMat)              rowClass = "maturity-row";
        else if (m.isPostMonth) rowClass = "posting-row";
        else if (m.isDepMonth)  rowClass = "deposit-row";
        else if (m.monthNum > investTenure) rowClass = "invest-stop";

        let tags = "";
        if (m.isDepMonth)                                      tags += `<span class="tag tag-dep">+dep</span> `;
        if (m.isPostMonth && !isMat)                           tags += `<span class="tag tag-post">post</span>`;
        if (isMat)                                             tags += `<span class="tag" style="background:rgba(240,164,66,.15);color:var(--amber)">✓ maturity</span>`;
        if (!m.isDepMonth && m.monthNum <= investTenure)       tags += `<span class="tag tag-hold">hold</span>`;
        if (m.monthNum > investTenure && !m.isPostMonth && !isMat) tags += `<span class="tag tag-hold">grow</span>`;

        const depCell = m.isDepMonth
            ? `<td class="r" style="color:var(--accent2);font-family:'DM Mono',monospace">${fmtINR(depositAmt)}</td>`
            : `<td class="r" style="color:var(--text3)">—</td>`;

        rows += `
            <tr class="${rowClass}">
                <td><span style="font-family:'DM Mono',monospace;color:var(--text)">${String(m.monthNum).padStart(2,"0")}</span> ${tags}</td>
                <td style="font-size:11px;color:var(--text3)">${fmtD(m.periodStart)} → ${fmtD(m.periodEnd)}</td>
                ${depCell}
                <td class="r">${fmtINR(m.principal)}</td>
                <td class="mono">${fmtINR(m.pBefore).replace("₹\u00A0","")} × ${(monthlyRate*100).toFixed(6)}%</td>
                <td class="r">${fmtINR(m.interest)}</td>
                <td class="r" style="color:${m.isPostMonth ? "var(--text3)" : "var(--amber)"}">
                    ${m.isPostMonth ? '<span style="color:var(--text3)">→ posted</span>' : fmtINR(m.accAfter)}
                </td>
                <td class="r">
                    ${m.isPostMonth
                        ? `<span style="color:var(--green)">${fmtINR(m.posted)}</span>`
                        : '<span style="color:var(--text3)">—</span>'}
                </td>
            </tr>`;
    }

    rows += `
        <tr class="total-row">
            <td colspan="5">Grand Total Interest</td>
            <td class="r" colspan="3">${fmtINR(totalInt)}</td>
        </tr>`;

    document.getElementById("tableBody").innerHTML = rows;

    document.getElementById("summaryPanel").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── FY Breakdown trigger ──────────────────────────────────

function runFYBreakdown() {
    hideError();
    const v = getValidatedInputs();
    if (!v) return;

    // Also run the main calc to show summary + month table
    runCalculator();

    // Then render FY table (defined in rd-table.js)
    renderRDFYTable(
        v.depositAmt, v.freqMonths, v.investTenure, v.matTenure,
        v.target, v.postFreq,
        v.startStr, v.endStr
    );
}