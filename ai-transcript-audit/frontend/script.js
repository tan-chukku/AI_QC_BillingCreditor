const transcriptInput = document.getElementById("transcript-input");
const resultStatus = document.getElementById("result-status");
const resultFields = [...document.querySelectorAll("[data-label]")];
const additionalClientPanels = document.getElementById("additional-client-panels");
const primaryResultsTable = document.querySelector(".results-table");
const primaryAuditChecklist = document.querySelector(".audit-checklist");
for (let clientIndex = 1; clientIndex <= 2; clientIndex += 1) {
    const panel = document.createElement("section");
    panel.className = "additional-client-panel";
    panel.setAttribute("aria-labelledby", `additional-client-${clientIndex + 1}-title`);

    const heading = document.createElement("h3");
    heading.id = `additional-client-${clientIndex + 1}-title`;
    heading.textContent = `Khách hàng ${clientIndex + 1}`;
    panel.append(heading);

    const tableScroll = document.createElement("div");
    tableScroll.className = "table-scroll";
    const table = primaryResultsTable.cloneNode(true);
    table.querySelectorAll("[data-key]").forEach((field) => {
        field.id = `client-${clientIndex + 1}-${field.id}`;
        field.dataset.clientIndex = String(clientIndex);
        field.value = "";
        resultFields.push(field);
    });
    tableScroll.append(table);
    panel.append(tableScroll);

    const checklist = primaryAuditChecklist.cloneNode(true);
    const checklistTitle = checklist.querySelector("h3");
    checklist.dataset.clientIndex = String(clientIndex);
    checklist.setAttribute("aria-labelledby", `audit-checklist-title-${clientIndex + 1}`);
    checklistTitle.id = `audit-checklist-title-${clientIndex + 1}`;
    checklistTitle.textContent = `Checklist audit · Khách hàng ${clientIndex + 1}`;
    checklist.querySelector(".audit-summary").id = `audit-summary-${clientIndex + 1}`;
    panel.append(checklist);
    additionalClientPanels.append(panel);
}
const copyButton = document.getElementById("copy-button");
const exportButton = document.getElementById("export-button");
const processingModeLabel = document.getElementById("processing-mode");
const privacyNote = document.getElementById("privacy-note");
let geminiEnabled = false;

async function readJsonResponse(response, endpointName) {
    const contentType = response.headers.get("content-type") || "";
    const responseText = await response.text();
    if (!contentType.toLowerCase().includes("application/json")) {
        if (response.status === 502) {
            throw new Error("Localtunnel trả HTTP 502 Bad Gateway. Kiểm tra server local, khởi động lại `npx localtunnel --port 3000` và mở URL mới.");
        }
        throw new Error(`${endpointName} trả HTTP ${response.status} với nội dung không phải JSON.`);
    }

    let payload;
    try {
        payload = JSON.parse(responseText);
    } catch {
        throw new Error(`${endpointName} trả dữ liệu JSON không hợp lệ (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(payload.error || `${endpointName} trả HTTP ${response.status}.`);
    return payload;
}

async function updateProcessingMode() {
    let healthError = "";
    try {
        const response = await fetch("/api/health");
        const health = await readJsonResponse(response, "Health check");
        geminiEnabled = response.ok && health.aiEnabled === true;
    } catch (error) {
        geminiEnabled = false;
        healthError = error instanceof TypeError
            ? "Không kết nối được server. Kiểm tra server local hoặc Localtunnel."
            : error.message;
    }

    processingModeLabel.textContent = geminiEnabled ? "Gemini AI · gửi transcript tới Google" : "Gemini AI chưa sẵn sàng";
    privacyNote.textContent = geminiEnabled
        ? "Transcript, gồm SSN và thông tin ngân hàng, sẽ được gửi tới Google Gemini để phân tích."
        : healthError || "Chưa cấu hình Gemini API key. Hãy cấu hình key và khởi động lại server để phân tích.";
    document.getElementById("analyze-button").disabled = !geminiEnabled;
}

updateProcessingMode();

function fillField(id, value) {
    document.getElementById(id).value = value || "";
}

function evaluateBankCaller(bank, callFrom) {
    const normalizedBank = String(bank || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    const normalizedCaller = String(callFrom || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    const bankRules = [
        { bank: /\b(?:CHASE|JPMORGAN CHASE)\b/, caller: "LAW OFFICE OF BAHRAM MADAEN", label: "Law Office of Bahram Madaen" },
        { bank: /\b(?:AMEX|AMERICAN EXPRESS|CAPITAL ONE)\b/, caller: "LAW OFFICE OF JASON RETTIG", label: "Law Office of Jason Rettig" }
    ];
    const rule = bankRules.find(({ bank: bankPattern }) => bankPattern.test(normalizedBank));
    if (!normalizedBank || !normalizedCaller) {
        return { passed: false, detail: "Thiếu Bank hoặc Call from trong transcript" };
    }
    if (!rule) {
        return { passed: false, detail: "Chưa có mapping cho Bank này; đối chiếu assigned company/POA trên CRM" };
    }
    if (normalizedCaller.includes(rule.caller)) {
        return { passed: true, detail: `${bank} → ${rule.label}` };
    }
    return {
        passed: false,
        detail: `Lỗi: ${bank} yêu cầu ${rule.label}; transcript ghi “${callFrom}”. Kiểm tra LPOA nếu hồ sơ có.`
    };
}

function updateAuditChecklist(result, rawText) {
    const clients = [result, ...(Array.isArray(result.additionalClients) ? result.additionalClients.slice(0, 2) : [])];
    const clientFields = [
        ["clientName", "Client name"],
        ["ssn", "SSN"],
        ["dob", "DOB"],
        ["settledReference", "Account/File/Reference #"]
    ];
    const settlementFields = [
        ["settlementOffer", "Settlement total"],
        ["paymentCount", "Số kỳ"],
        ["amount", "Amount"],
        ["processPaymentDate", "Ngày charge"]
    ];
    document.querySelectorAll(".audit-checklist").forEach((checklist) => {
        const clientIndex = Number(checklist.dataset.clientIndex || 0);
        const client = clients[clientIndex] || {};
        const bankCallerStatus = evaluateBankCaller(client.bank, client.callFrom);
        checklist.querySelector('[data-audit-auto="bank-caller"]').checked = bankCallerStatus.passed;
        checklist.querySelector('[data-audit-detail="bank-caller"]').textContent = bankCallerStatus.detail;
        const setAutomatedStatus = (key, fields) => {
            const missing = fields.filter(([field]) => !String(client[field] || "").trim()).map(([, label]) => label);
            checklist.querySelector(`[data-audit-auto="${key}"]`).checked = missing.length === 0;
            checklist.querySelector(`[data-audit-detail="${key}"]`).textContent = missing.length
                ? `Thiếu: ${missing.join(", ")}`
                : "Đủ dữ liệu khách hàng này";
        };

        setAutomatedStatus("client-info", clientFields);
        setAutomatedStatus("settlement", settlementFields);
        setAutomatedStatus("ach", [
            ["routing", "Routing number"],
            ["withdrawalAccount", "Account Number ACH"]
        ]);

        const confirmation = String(client.confirmationNumber || "").trim();
        const hasConfirmation = Boolean(confirmation);
        checklist.querySelector('[data-audit-auto="confirmation"]').checked = hasConfirmation;
        checklist.querySelector('[data-audit-detail="confirmation"]').textContent = hasConfirmation
            ? (/(?:^|\b)n\s*\/\s*a(?:\b|$)/i.test(confirmation) ? "Transcript ghi nhận N/A" : "Có confirmation number")
            : "Thiếu confirmation/N/A";

        const disclosureStatus = client.disclosureStatus;
        const disclosureCheckbox = checklist.querySelector('[data-audit-auto="disclosure"]');
        const disclosureDetail = checklist.querySelector('[data-audit-detail="disclosure"]');
        disclosureCheckbox.checked = disclosureStatus === "match";
        if (disclosureStatus === "not_found") {
            disclosureDetail.textContent = client.disclosureNotes || "Không có xác nhận cuối từ bank (không có disclosure)";
        } else if (disclosureStatus === "match") {
            disclosureDetail.textContent = client.disclosureNotes || "Xác nhận cuối từ bank khớp payment setup";
        } else if (disclosureStatus === "mismatch") {
            disclosureDetail.textContent = `Không khớp: ${client.disclosureNotes || "kiểm tra lại payment terms"}`;
        } else {
            disclosureDetail.textContent = `Cần nghe lại: ${client.disclosureNotes || "chưa đủ dữ liệu để so sánh"}`;
        }

        const autoItems = [...checklist.querySelectorAll("[data-audit-auto]")];
        const completed = autoItems.filter((item) => item.checked).length;
        const manualPending = [...checklist.querySelectorAll("[data-audit-manual]")].filter((item) => !item.checked).length;
        checklist.querySelector(".audit-summary").textContent = `Dữ liệu transcript: ${completed}/${autoItems.length} mục đủ thông tin · Cần auditor xác nhận: ${manualPending} mục.`;
    });
}

function resetAuditChecklist() {
	    document.querySelectorAll(".audit-checklist").forEach((checklist) => {
	        checklist.querySelectorAll("[data-audit-auto]").forEach((checkbox) => { checkbox.checked = false; });
	        checklist.querySelectorAll("[data-audit-detail]").forEach((detail) => { detail.textContent = "Chưa đánh giá"; });
	        checklist.querySelector(".audit-summary").textContent = "Checklist sẽ được cập nhật sau khi Gemini phân tích transcript.";
	    });
}

async function analyzeTranscript() {
    const rawText = transcriptInput.value.trim();
    if (!rawText) {
        resultStatus.textContent = "Hãy dán transcript hoặc mở một tệp trước khi tổng hợp.";
        transcriptInput.focus();
        return;
    }
    if (!geminiEnabled) {
        resultStatus.textContent = "Gemini chưa sẵn sàng. Hãy cấu hình API key rồi khởi động lại server.";
        return;
    }

    document.querySelectorAll("[data-audit-manual]").forEach((checkbox) => { checkbox.checked = false; });
    resetAuditChecklist();
    const analyzeButton = document.getElementById("analyze-button");
    analyzeButton.disabled = true;
    resultStatus.textContent = "Đang gửi transcript tới Google Gemini để phân tích...";
    try {
        const response = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transcript: rawText })
        });
        const result = await readJsonResponse(response, "Gemini API");

        resultFields.forEach((field) => {
            const clientIndex = Number(field.dataset.clientIndex || 0);
            const clientData = clientIndex === 0 ? result : result.additionalClients?.[clientIndex - 1];
            fillField(field.id, clientData?.[field.dataset.key]);
        });
        updateAuditChecklist(result, rawText);

        resultStatus.textContent = "Đã trích xuất bằng Gemini. Hãy rà soát kỹ thông tin nhạy cảm trước khi lưu hoặc chia sẻ.";
        copyButton.disabled = false;
        exportButton.disabled = false;
    } catch (error) {
        resultStatus.textContent = error instanceof TypeError
            ? "Không kết nối được backend. Hãy chạy node src/index.js trong thư mục dự án."
            : error.message;
    } finally {
        analyzeButton.disabled = false;
    }
}

function getResultText() {
    const fieldResults = resultFields.map((field) => {
        const clientIndex = Number(field.dataset.clientIndex || 0);
        const label = clientIndex === 0 ? field.dataset.label : `Khách hàng ${clientIndex + 1} · ${field.dataset.label}`;
        return `## ${label}\n${field.value.trim() || "Chưa xác định"}`;
    }).join("\n\n");
    const checklistResults = [...document.querySelectorAll(".audit-checklist")].map((checklist, clientIndex) => {
        const items = [...checklist.querySelectorAll(".audit-list li")].map((item) => {
            const checkbox = item.querySelector("input");
            const label = item.querySelector("label span").textContent;
            const detail = item.querySelector("small")?.textContent || "";
            const status = checkbox.disabled ? (checkbox.checked ? "Đủ dữ liệu" : "Thiếu/chưa xác định") : (checkbox.checked ? "Auditor xác nhận" : "Chưa xác nhận");
            return `- [${checkbox.checked ? "x" : " "}] ${label}: ${status}${detail ? ` (${detail})` : ""}`;
        }).join("\n");
        return `## Checklist audit · Khách hàng ${clientIndex + 1}\n${items}`;
    }).join("\n\n");
    return `${fieldResults}\n\n${checklistResults}`;
}

function downloadResult() {
    const blob = new Blob([`# Client settlement details\n\n${getResultText()}\n`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "client-settlement-details.md";
    link.click();
    URL.revokeObjectURL(url);
}

document.getElementById("analyze-button").addEventListener("click", analyzeTranscript);
document.getElementById("clear-button").addEventListener("click", () => {
    transcriptInput.value = "";
    resultFields.forEach((field) => { field.value = ""; });
    document.querySelectorAll("[data-audit-manual]").forEach((checkbox) => { checkbox.checked = false; });
    resetAuditChecklist();
    document.getElementById("word-count").textContent = "0 từ";
    resultStatus.textContent = "Đã xóa transcript.";
    copyButton.disabled = true;
    exportButton.disabled = true;
    transcriptInput.focus();
});

transcriptInput.addEventListener("input", () => {
    const wordCount = transcriptInput.value.trim().split(/\s+/).filter(Boolean).length;
    document.getElementById("word-count").textContent = `${wordCount.toLocaleString("vi-VN")} từ`;
});

document.getElementById("file-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
        transcriptInput.value = String(reader.result || "");
        transcriptInput.dispatchEvent(new Event("input"));
        resultStatus.textContent = `Đã mở tệp “${file.name}”.`;
    });
    reader.addEventListener("error", () => {
        resultStatus.textContent = "Không thể đọc tệp này. Hãy thử lại với tệp .txt hoặc .md.";
    });
    reader.readAsText(file);
    event.target.value = "";
});

copyButton.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(getResultText());
        resultStatus.textContent = "Đã sao chép biên bản.";
    } catch {
        resultStatus.textContent = "Không thể sao chép tự động trong trình duyệt này.";
    }
});

exportButton.addEventListener("click", downloadResult);