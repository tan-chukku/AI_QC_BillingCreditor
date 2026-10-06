const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_SIZE = 2 * 1024 * 1024;
const FRONTEND_DIRECTORY = path.resolve(__dirname, "../frontend");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const fieldDefinitions = [
	{ key: "clientName", aliases: ["Client name", "Customer name", "Borrower name", "Tên khách hàng"] },
	{ key: "dob", aliases: ["DOB", "Date of birth", "Birth date", "Ngày sinh"] },
	{ key: "ssn", aliases: ["SSN", "Social Security Number", "Social Security No", "Social Security #", "SS number", "SS#"] },
	{ key: "address", aliases: ["Client address", "Mailing address", "Address", "Địa chỉ"] },
	{ key: "phone", aliases: ["Client phone", "Phone number", "Telephone", "Mobile number", "Phone", "Số điện thoại"] },
	{ key: "callFrom", aliases: ["Call from", "Calling from", "Caller company", "Organization calling from"] },
	{ key: "bank", aliases: ["Bank", "Creditor bank", "Financial institution called", "Tên ngân hàng"] },
	{ key: "settledReference", aliases: ["Account/File #/Reference # settled", "Account/File/Reference settled", "Settled account number", "Settled account", "Account settled", "File number", "Reference number"] },
	{ key: "withdrawalAccount", aliases: ["Account (to withdraw)", "Account to withdraw", "Bank account to withdraw from", "Account for withdrawal", "Withdrawal account", "Số tài khoản rút tiền"] },
	{ key: "routing", aliases: ["Routing number", "Routing", "ABA number"] },
	{ key: "settlementOffer", aliases: ["Settlement offer", "Settlement amount", "Offer amount"] },
	{ key: "paymentCount", aliases: ["Number to make payment", "Number of payments", "Number of installments", "Payment count", "Installment count"] },
	{ key: "amount", aliases: ["Payment amount", "Amount to pay", "Amount"] },
	{ key: "processPaymentDate", aliases: ["Process payment date", "Payment process date", "Date to process payment", "Process date"] },
	{ key: "confirmationNumber", aliases: ["Confirmation number", "Confirmation #", "Confirmation no", "Confirmation code"] },
	{ key: "disclosure", aliases: ["Disclosure", "Payment disclosure", "Disclosure statement"] }
];

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const fieldMatchers = fieldDefinitions.flatMap((field) => field.aliases.map((alias) => ({
	key: field.key,
	aliasLength: alias.length,
	valuePattern: new RegExp(`^\\s*${escapeRegex(alias)}\\s*(?::|：|=|–|—|\\s+-\\s+|\\s+is\\s+|\\s+was\\s+|\\s+)(.*)$`, "iu"),
	labelPattern: new RegExp(`^\\s*${escapeRegex(alias)}\\s*$`, "iu")
}))).sort((left, right) => right.aliasLength - left.aliasLength);

const monthNames = "January|February|March|April|May|June|July|August|September|October|November|December";
const dateValue = `(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}|(?:${monthNames})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{2,4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${monthNames})(?:,?\\s+\\d{2,4})?)`;
const paymentCountWords = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20" };
const paymentCountToken = `\\d{1,2}|${Object.keys(paymentCountWords).join("|")}`;

function isPlaceholderValue(value) {
	const normalized = String(value || "").trim().toUpperCase();
	return ["", "N/A", "NA", "NUMBER", "NUM"].includes(normalized);
}

function isConfirmationNoise(value) {
	const normalized = String(value || "").trim().toUpperCase();
	return !normalized || normalized.includes("NUMBER") || normalized.includes("CONFIRMATION") || normalized.includes("CLIENTNAME") || normalized.includes("AVAILABLE") || normalized.includes("GONNABE") || normalized.includes("ISGONNABE");
}

function assignFieldValue(result, key, rawValue) {
	if (rawValue === undefined || rawValue === null) return;
	const candidate = String(rawValue).trim().replace(/[\s,;.!?]+$/, "");
	if (!candidate || isPlaceholderValue(candidate)) return;
	const normalizedRoute = key === "routing" ? candidate.match(/\b\d{3}(?:[-\s]?\d{3}){2}\b/)?.[0] : null;
	if (key === "routing" && normalizedRoute) {
		if (!result[key] || isPlaceholderValue(result[key])) result[key] = normalizedRoute;
		return;
	}
	if (key === "confirmationNumber") {
		const normalized = normalizeConfirmationCode(candidate);
		if (!normalized) return;
		if (!result[key] || isConfirmationNoise(result[key]) || result[key].length < normalized.length) result[key] = normalized;
		return;
	}
	if (!result[key] || isPlaceholderValue(result[key])) result[key] = candidate;
}

function setIfMissing(result, key, value) {
	assignFieldValue(result, key, value);
}

function normalizePaymentCount(value) {
	if (!value) return "";
	const token = value.match(new RegExp(`\\b(${paymentCountToken})\\b`, "i"))?.[1];
	return token ? paymentCountWords[token.toLowerCase()] || String(Number(token)) : "";
}

function normalizeSsnCandidate(value) {
	const candidate = String(value || "").match(/^[\dXx*][\dXx* -]{1,22}/)?.[0].trim() || "";
	const symbols = candidate.match(/[\dXx*]/g) || [];
	return [3, 4, 9].includes(symbols.length) ? candidate : "";
}

function normalizeConfirmationCode(value) {
	if (value === null || value === undefined) return "";
	let cleaned = String(value).trim();
	for (let iteration = 0; iteration < 3; iteration += 1) {
		const next = cleaned.replace(/^(?:number\s*|confirmation(?:\s*(?:number|#|no\.?|code|available|is|gonna|be))*)/i, "");
		if (next === cleaned) break;
		cleaned = next;
	}
	cleaned = cleaned.replace(/^\s*[:=.-]+\s*/, "");
	if (!cleaned) return "";
	if (/^(?:client|customer|name|address|phone|dob|ssn|routing|settlement|offer|amount|payment|process|date|confirmation|available|would|you|like|all|just|first|last|or|caller|agent|yeah|perfect)\b/i.test(cleaned)) return "";
	if (/\b(?:caller|client|customer|name|agent|yeah|perfect|would|you|like|all|just|first|last|or)\b/i.test(cleaned)) return "";
	const compact = cleaned
		.replace(/\b(?:as\s+in\s+)[A-Za-z]+\b/gi, " ")
		.replace(/[^A-Za-z0-9]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!compact) return "";
	const tokens = compact.match(/[A-Za-z0-9]+/g) || [];
	const normalized = tokens.join("").toUpperCase();
	return ["NUMBER", "NUM", "NA", "N/A"].includes(normalized) ? "" : normalized;
}

function getBestConfirmationValue(text) {
	const candidates = [];
	for (const match of text.matchAll(/([A-Z])\s+as\s+in\s+[A-Za-z]+(?:\s*,\s*(\d+))?/gi)) {
		const letter = match[1]?.toUpperCase();
		const digit = match[2] || "";
		if (!letter) continue;
		candidates.push(`${letter}${digit}`);
	}
	for (const match of text.matchAll(/([A-Z])\s+as\s+in\s+[A-Za-z]+(?:\s*,\s*\d+)?(?:\s*,\s*([A-Z])\s+as\s+in\s+[A-Za-z]+(?:\s*,\s*\d+)?)+/gi)) {
		const normalized = normalizeConfirmationCode(match[0]);
		if (normalized) candidates.push(normalized);
	}
	for (const match of text.matchAll(/\bconfirmation(?:\s+(?:number|#|no\.?|code))?\b[^.!?]{0,100}?\b(?:is(?:\s+(?:gonna|going to)\s+be)?|will\s+be|:|=)\s*([A-Za-z0-9][A-Za-z0-9-]{2,})\b/gi)) {
		const normalized = normalizeConfirmationCode(match[1]);
		if (normalized) candidates.push(normalized);
	}
	for (const match of text.matchAll(/\bconfirmation(?:\s+(?:number|#|no\.?|code))?\b[^.!?]*?\?\s*(?:[\p{Lu}][\p{L} .'-]{0,35}:\s*)?([^.!?]*)/giu)) {
		const normalized = normalizeConfirmationCode(match[1]);
		if (normalized) candidates.push(normalized);
	}
	return candidates.sort((left, right) => right.length - left.length)[0] || "";
}

function extractPaymentTiers(text, totalCount = 0) {
	const pattern = new RegExp(`\\b(${paymentCountToken})\\s+(?:equal\\s+)?payments?\\s+(?:of|at)\\s*(\\$\\s?[\\d,]+(?:\\.\\d{2})?)`, "gi");
	const tiers = [...text.matchAll(pattern)].map((match) => ({
		count: Number(normalizePaymentCount(match[1])),
		amount: match[2].trim(),
		value: Number(match[2].replace(/[^\d.]/g, ""))
	}));
	const firstTierPattern = new RegExp(`\\bfirst\\s+(${paymentCountToken})\\s+payments?\\s+(?:(?:will\\s+be|are)\\s+)?(?:for|of|at)\\s*(\\$\\s?[\\d,]+(?:\\.\\d{2})?)`, "gi");
	for (const match of text.matchAll(firstTierPattern)) {
		tiers.push({
			count: Number(normalizePaymentCount(match[1])),
			amount: match[2].trim(),
			value: Number(match[2].replace(/[^\d.]/g, ""))
		});
	}
	if (totalCount > 0) {
		const remainingAmount = text.match(/\b(?:the\s+)?remaining\s+payments?\s+(?:(?:will|would)\s+be\s+|are\s+)?(?:for|of|at)\s*(\$\s?[\d,]+(?:\.\d{2})?)/i)?.[1];
		const remainingCount = totalCount - tiers.reduce((sum, tier) => sum + tier.count, 0);
		if (remainingAmount && remainingCount > 0) {
			tiers.push({
				count: remainingCount,
				amount: remainingAmount.trim(),
				value: Number(remainingAmount.replace(/[^\d.]/g, ""))
			});
		}
	}
	return tiers;
}

function extractSetupPaymentCount(text) {
	if (/\bagreed to (?:make )?(?:a|one) payment\b/i.test(text)) return "1";
	const setupAction = /\b(?:set\s*up|setup|schedule|scheduled|process|make|draft|debit)\b/i;
	const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
	let committedCount = "";
	for (const sentence of sentences) {
		if (sentence.includes("?") || !setupAction.test(sentence)) continue;
		const actionIndex = sentence.search(setupAction);
		const actionText = sentence.slice(actionIndex);
		const scheduledTiers = extractPaymentTiers(actionText);
		const setupCount = actionText.match(new RegExp(`\\b(?:all\\s+)?(${paymentCountToken})\\s+(?:equal\\s+)?(?:payments?|installments?)\\b`, "i"));
		if (scheduledTiers.length > 1) {
			committedCount = String(scheduledTiers.reduce((total, tier) => total + tier.count, 0));
		} else if (setupCount) {
			committedCount = normalizePaymentCount(setupCount[1]);
		} else if (/\bone[- ]time payment\b|\b(?:first|initial|only)\s+(?:payment|installment|confirmation)\b/i.test(actionText)) {
			committedCount = "1";
		}
	}
	if (committedCount) return committedCount;

	const choiceQuestions = [...text.matchAll(/\b(?:would you like|do you want|should we|would you prefer)\b[^.!?]*\?/gi)];
	for (const questionMatch of choiceQuestions) {
		const question = questionMatch[0];
		if (!/\ball\b/i.test(question) || !/\bfirst\b/i.test(question) || !/\b(?:payments?|installments?|confirmation)\b/i.test(question)) continue;
		const responseText = text.slice(questionMatch.index + question.length).match(/^\s*(?:[\p{Lu}][\p{L}\p{N} .'-]{0,35}:\s*)?([^.!?]+)/u)?.[1]?.trim() || "";
		if (/^(?:just|only)\s+(?:the\s+)?first\b/i.test(responseText)) return "1";
		if (/^(?:all\b|yes\b)/i.test(responseText)) {
			const offeredCount = question.match(new RegExp(`\\ball\\s+(${paymentCountToken})\\s+(?:payments?|installments?)`, "i"))?.[1];
			if (offeredCount) return normalizePaymentCount(offeredCount);
		}
	}
	if (/\bone[- ]time payment\b/i.test(text)) return "1";
	return "";
}

function extractDatesInOrder(text, defaultYear) {
	const pattern = new RegExp(`\\b(?:(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?|(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}))\\b`, "gi");
	return [...text.matchAll(pattern)].map((match) => match[4] || `${match[1]} ${Number(match[2])}${match[3] || defaultYear ? `, ${match[3] || defaultYear}` : ""}`);
}

function extractConversationalValues(rawText, result) {
	const text = rawText.replace(/\s+/g, " ").trim();
	const clientName = text.match(/\b(?:you said (?:that )?your name is|your name is|client(?:'s)? name is)\s+([\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3})(?=\s*(?:[,;.!?]|\band\b|\bright\b|$))/iu);
	setIfMissing(result, "clientName", clientName?.[1]);
	const firstName = text.match(/\bfirst name\s+(?:is\s+)?([\p{Lu}][\p{L}'’-]*)\b/iu)?.[1];
	const directLastName = text.match(/\b(?:client's\s+)?last name\s+(?:is|:)\s*([\p{Lu}][\p{L}'’-]*)\b/u)?.[1];
	const lastNameQuestion = text.match(/\b(?:what(?:'s|\s+is)|may i have)\s+(?:the\s+)?last name\b[^?]*\?/i);
	const lastNameAnswer = lastNameQuestion
		? text.slice(lastNameQuestion.index + lastNameQuestion[0].length, lastNameQuestion.index + lastNameQuestion[0].length + 700)
			.match(/\b(?:so\s+)?(?:it'?s|it is)\s+([\p{Lu}][\p{L}'’-]*)\b/u)?.[1]
		: "";
	if (firstName && (directLastName || lastNameAnswer)) {
		setIfMissing(result, "clientName", `${firstName} ${directLastName || lastNameAnswer}`);
	}

	const dateOfBirth = text.match(new RegExp(`\\b(?:date of birth|DOB|born(?: on)?)\\s*(?:is|was|:)?\\s*(${dateValue})`, "i"));
	setIfMissing(result, "dob", dateOfBirth?.[1]);

	const ssn = text.match(/\b(?:social security(?: number)?|SSN)\s*(?:is|number is|:)?\s*([\dXx* -]{4,})/i);
	const socialOfClient = text.match(/\b(?:social(?: security)?(?: number)?\s+(?:of|for)\s+(?:the\s+)?(?:client|customer)|(?:client|customer)(?:'s)?\s+social(?: security)?(?: number)?)\s*(?:is|are|:)?\s*([\dXx* -]{3,})/i);
	const spokenLastDigits = text.match(/\blast\s+(?:three|four|3|4)(?:\s+digits?)?\s+of\s+(?:the\s+)?(?:client's?\s+)?(?:social(?: security)?(?: number)?|SSN)\s*(?:is|are|:)\s*([0-9Xx*][0-9Xx* -]{1,22})/i);
	let answeredLastDigits = "";
	const ssnQuestion = text.match(/\blast\s+(?:three|four|3|4)(?:\s+digits?)?[^?]{0,80}\b(?:social(?: security)?(?: number)?|SSN)\b[^?]*\?/i);
	if (ssnQuestion) {
		const answerStart = ssnQuestion.index + ssnQuestion[0].length;
		const answerText = text.slice(answerStart).match(/^\s*(?:[\p{Lu}][\p{L} .'-]{0,35}:\s*)?([^.!?]*)/iu)?.[1] || "";
		const answerWindow = text.slice(answerStart, answerStart + 180).split("?")[0];
		const lastDigitsAnswer = answerWindow.match(/\blast\s+(?:three|four|3|4)(?:\s+digits?)?\s*(?:are|is|:)?\s*([0-9Xx*][0-9X		npx localtunnel --port 3000x* -]{1,22})/i)?.[1];
		answeredLastDigits = answerText.match(/\b([0-9Xx*][0-9Xx* -]{1,22})\b/)?.[1] || lastDigitsAnswer || "";
	}
	setIfMissing(result, "ssn", ssn?.[1] || socialOfClient?.[1] || spokenLastDigits?.[1] || answeredLastDigits);

	const address = text.match(/\b(?:home |mailing |current )?address\s*(?:is|:)?\s*(\d{1,6}\s+[^.!?]{3,100})/i)
		|| text.match(/\b(?:lives at|live at|living at)\s+([^.!?]{5,120})/i);
	setIfMissing(result, "address", address?.[1]);

	const phone = text.match(/\b(?:phone|telephone|mobile|cell)\s+(?:number\s*)?(?:is|:)?\s*(\+?[\d(][\d() .-]{6,}\d)/i)
		|| text.match(/\b(?:call me at|reach me at)\s*(\+?[\d(][\d() .-]{6,}\d)/i);
	setIfMissing(result, "phone", phone?.[1]);

	const callFrom = text.match(/\bcalling from\s+(.+?)(?=\s+(?:on a recorded line|to\s+(?:make|discuss|assist|help)|regarding|about)\b|[,;.!?]|$)/i)
		|| text.match(/\bmy name is\s+[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3}\s+from\s+([^.!?]+)/iu);
	setIfMissing(result, "callFrom", callFrom?.[1]);

	const settledReference = text.match(/\b(?:settled|settlement)\s+(?:account|file|reference)\s+(?:(?:number|no\.?|#)\s*(?:is|:|of)?\s*|(?:is|:|of)\s*)([A-Z0-9-]{4,})/i);
	setIfMissing(result, "settledReference", settledReference?.[1]);
	const accountNumbers = [...text.matchAll(/\baccount\s*(?:number|#)\s*(?:is|:)?\s*([\d][\d -]{8,}\d)\b/gi)];
	for (const match of accountNumbers) {
		const previousBreaks = [".", "?", "!"].map((character) => text.lastIndexOf(character, match.index));
		const nextBreaks = [".", "?", "!"].map((character) => {
			const index = text.indexOf(character, match.index + match[0].length);
			return index === -1 ? text.length : index;
		});
		const sentenceStart = Math.max(...previousBreaks) + 1;
		const sentenceEnd = Math.min(...nextBreaks);
		const context = text.slice(sentenceStart, sentenceEnd);
		if (/\b(?:checking|savings|bank account|routing|ACH|withdraw(?:al)?)\b/i.test(context)) {
			setIfMissing(result, "withdrawalAccount", match[1]);
		} else {
			setIfMissing(result, "settledReference", match[1]);
		}
	}
	const cardNumber = text.match(/\b(?:credit\s+)?card\s*(?:number|#)\s*(?:is|:)?\s*([\d][\d -]{8,}\d)\b/i);
	const cardNumberQuestion = text.match(/\b(?:credit\s+)?card\s*(?:number|#)\b[^?]*\?\s*(?:[\p{Lu}][\p{L} .'-]{0,35}:\s*)?([^.!?]*)/iu);
	const cardNumberAnswer = cardNumberQuestion?.[1].match(/\b(\d[\d -]{8,}\d)\b/);
	setIfMissing(result, "settledReference", cardNumber?.[1] || cardNumberAnswer?.[1]);
	const rawEndingInAccount = text.match(/\b(?:account|file|reference)\b[^.!?]{0,60}?\bending\s+in\s+(\d{3,4})\b/i)
		|| text.match(/\bending\s+in\s+(\d{3,4})\b[^.!?]{0,60}\b(?:account|reference|file)\b/i);
	const hasWithdrawalAccountContext = /\b(?:checking|savings|bank|routing|ABA|ACH|account\s+to\s+withdraw|withdrawal account)\b/i.test(text);
	const withdrawalAccount = hasWithdrawalAccountContext
		? (text.match(/\b(?:checking(?:\s+or\s+savings)?|savings|bank|withdrawal|personal|business|account\s+to\s+withdraw)\s+(?:account\s+)?(?:number|#)?\s*(?:ending (?:in )?|is|:)?\s*([\dX* -]{4,})/i)
			|| text.match(/\b(?:account\s+to\s+withdraw|checking\s+account\s+number|savings\s+account\s+number|bank\s+account\s+number)\s*(?:is|:)?\s*([\dX* -]{4,})/i)
			|| text.match(/\baccount\s+(?:ending (?:in )?|number is\s+)([\dX* -]{4,})[^.!?]{0,40}(?:withdraw|debit)/i)
			|| text.match(/\b(?:that'?s|it\s+is|number\s+is)\s*([\dX*][\dX* -]{4,}\d)\b(?=[^.!?]{0,40}\b(?:withdraw|debit|bank|checking|savings|ACH)\b)/i))?.[1] ?? null
		: null;
	if (rawEndingInAccount && !hasWithdrawalAccountContext) {
		setIfMissing(result, "settledReference", `ending in ${rawEndingInAccount[1]}`);
	} else if (rawEndingInAccount && hasWithdrawalAccountContext) {
		setIfMissing(result, "withdrawalAccount", withdrawalAccount);
		setIfMissing(result, "settledReference", `ending in ${rawEndingInAccount[1]}`);
	} else {
		setIfMissing(result, "withdrawalAccount", withdrawalAccount);
	}
	const debitedAccountEnding = text.match(/\b(?:debits?|withdrawals?)\b[^.!?]{0,70}?\baccount(?: number)?\s+ending\s+(?:in\s+)?([\dXx*]{4})\b/i);
	setIfMissing(result, "withdrawalAccount", debitedAccountEnding?.[1]);
	const bankAccountQuestion = text.match(/\b(?:checking(?:\s+or\s+savings)?|savings|bank|account\s+to\s+withdraw|personal\s+(?:checking|savings)|business\s+(?:checking|savings))\s*(?:account\s*)?(?:number|#)\b[^?]*\?\s*(?:[\p{Lu}][\p{L} .'-]{0,35}:\s*)?([^.!?]*)/iu);
	const bankAccountAnswer = bankAccountQuestion?.[1].match(/\b([\dXx*][\dXx* -]{2,}\d)\b/);
	setIfMissing(result, "withdrawalAccount", bankAccountAnswer?.[1]);
	if (result.withdrawalAccount && /\bending\s+in\s+\d{3,4}\b/i.test(text) && result.withdrawalAccount.length <= 4) {
		delete result.withdrawalAccount;
	}
	const accountEndings = [...text.matchAll(/\b(?:client(?:'s)?\s+)?(?:(?:credit|debt)\s+)?(?:card(?: account)?|account)(?: number)?\b[^.!?]{0,60}?\bending\s+(?:in|with)\s+([\dXx*]{3,4})\b/gi)];
	for (const match of accountEndings) {
		const previousBreaks = [".", "?", "!"].map((character) => text.lastIndexOf(character, match.index));
		const nextBreaks = [".", "?", "!"].map((character) => {
			const index = text.indexOf(character, match.index + match[0].length);
			return index === -1 ? text.length : index;
		});
		const sentenceStart = Math.max(...previousBreaks) + 1;
		const sentenceEnd = Math.min(...nextBreaks);
		const context = text.slice(sentenceStart, sentenceEnd);
		const isBankContext = /\b(?:checking|savings|bank|routing|ABA|ACH|account\s+to\s+withdraw|withdrawal account)\b/i.test(context);
		const isDateContext = /\b(?:date of birth|DOB|born|birth date|year)\b/i.test(match[0]);
		if (isBankContext && !isDateContext) {
			setIfMissing(result, "withdrawalAccount", match[1]);
		} else if (!isDateContext) {
			setIfMissing(result, "settledReference", `ending in ${match[1]}`);
		}
	}
	const dobYear = String(result.dob || "").match(/\b(?:19|20)\d{2}\b/)?.[0];
	if (dobYear && result.withdrawalAccount && result.withdrawalAccount.replace(/\D/g, "") === dobYear) {
		result.withdrawalAccount = "";
	}

	const routingAccountPair = text.match(/\b(?:routing|ABA)(?:\s+transit)?(?:\s+number)?\s*(?:is|:|=)?\s*(\d{3}(?:[-\s]?\d{3}){2})\b[\s\S]{0,1200}?\baccount(?:\s+number)?[\s\S]{0,120}?([\dXx*][\dXx* -]{4,}\d)\b/i);
	if (routingAccountPair) {
		const debtEndingMatch = text.match(/\b(?:account|file|reference)\b[^.!?]{0,60}?\bending\s+in\s+(\d{3,4})\b/i);
		if (result.settledReference === routingAccountPair[2]) {
			result.settledReference = debtEndingMatch ? `ending in ${debtEndingMatch[1]}` : "";
		}
		setIfMissing(result, "routing", routingAccountPair[1]);
		setIfMissing(result, "withdrawalAccount", routingAccountPair[2]);
	}

	const routing = text.match(/\b(?:routing|ABA)(?: transit)?\s*(?:number|#)?\s*(?:is|:)?\s*(\d{3}(?:[-\s]?\d{3}){2})\b/i);
	setIfMissing(result, "routing", routing?.[1]);
	const routingQuestion = text.match(/\b(?:routing|ABA)(?: transit)?\s*(?:number|#)\b[^?]*\?\s*(?:[\p{Lu}][\p{L} .'-]{0,35}:\s*)?([^.!?]*)/iu);
	const routingAnswer = routingQuestion?.[1].match(/\b(\d{3}(?:[-\s]?\d{3}){2})\b/);
	setIfMissing(result, "routing", routingAnswer?.[1]);
	const spokenRouting = text.match(/\b(?:routing|ABA)(?:\s+transit)?(?:\s+number)?\s*(?:is|will be|:|=)?\s*(\d[\d -]{6,20}\d)\b/i)?.[1];
	const normalizedSpokenRouting = spokenRouting?.replace(/\D/g, "") || "";
	if (normalizedSpokenRouting.length === 9 && String(result.routing || "").replace(/\D/g, "").length !== 9) {
		result.routing = spokenRouting;
	}
	for (const accountQuestion of text.matchAll(/\baccount\s+number\b[^?]*\?/gi)) {
		const contextStart = Math.max(0, accountQuestion.index - 400);
		const nearbyContext = text.slice(contextStart, accountQuestion.index + accountQuestion[0].length);
		if (!/\b(?:routing|ABA|ACH|checking|savings|bank)\b/i.test(nearbyContext)) continue;
		const answerText = text.slice(accountQuestion.index + accountQuestion[0].length)
			.match(/^\s*(?:[\p{Lu}][\p{L}\p{N} .'-]{0,35}:\s*)?([^.!?]*)/iu)?.[1] || "";
		const accountAnswer = answerText.match(/\b([\dXx*][\dXx* -]{7,}[\dXx*])\b/)?.[1]?.trim();
		const answerDigitCount = accountAnswer?.replace(/\D/g, "").length || 0;
		const currentDigitCount = String(result.withdrawalAccount || "").replace(/\D/g, "").length;
		if (!accountAnswer || answerDigitCount < 9 || accountAnswer.replace(/\D/g, "") === normalizedSpokenRouting) continue;
		if (currentDigitCount < answerDigitCount) result.withdrawalAccount = accountAnswer;
		break;
	}

	const settlementOffer = text.match(/\b(?:total settlement|settlement (?:offer|amount)|offer to settle)\s*(?:is|of|for|:)?\s*(\$\s?[\d,]+(?:\.\d{2})?)/i)
		|| text.match(/\bsettlement\b[^.!?]{0,80}?\b(?:for the amount of|for an amount of|totaling|totalling)\s*(\$\s?[\d,]+(?:\.\d{2})?)/i);
	setIfMissing(result, "settlementOffer", settlementOffer?.[1]);

	const explicitPaymentCount = text.match(new RegExp(`\\b(?:number of payments?|payment count|installment count|in total|total(?: of)?)\\s*(?:is|:)?\\s*(${paymentCountToken})\\b`, "i"));
	const paymentCount = explicitPaymentCount?.[1] || extractSetupPaymentCount(text);
	setIfMissing(result, "paymentCount", paymentCount);

	const paymentTiers = extractPaymentTiers(text, Number(normalizePaymentCount(result.paymentCount)));
	if (paymentTiers.length > 1) {
		result.amount = paymentTiers.map((tier) => `${tier.count} × ${tier.amount}`).join("; ");
	}
	const installmentAmount = text.match(/\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:equal\s+)?payments?\s+(?:of|at)\s*(\$\s?[\d,]+(?:\.\d{2})?)/i)
		|| text.match(/\b(?:each|per)\s+payment\s*(?:is|of|:)?\s*(\$\s?[\d,]+(?:\.\d{2})?)/i)
		|| text.match(/\bagreed to (?:make )?(?:a|one) payment\s+(?:of|for)\s*(\$\s?[\d,]+(?:\.\d{2})?)/i);
	if (paymentTiers.length <= 1) setIfMissing(result, "amount", installmentAmount?.[1]);
	if (!result.settlementOffer && paymentTiers.length) {
		const totalCount = paymentTiers.reduce((total, tier) => total + tier.count, 0);
		const totalAmount = paymentTiers.reduce((total, tier) => total + tier.count * tier.value, 0);
		const total = totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		const breakdown = paymentTiers.map((tier) => `${tier.count} × ${tier.amount}`).join(" + ");
		result.settlementOffer = `$${total} (calculated: ${breakdown})`;
	}

	const paymentSentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => /\b(?:payments?|withdrawal|withdraw|debit|process)\b/i.test(sentence));
	const year = text.match(/\b(?:all in (?:the )?year|in (?:the )?year)\s+(\d{4})\b/i)?.[1];
	const paymentDates = paymentSentences.flatMap((sentence) => [
		...extractDatesInOrder(sentence, year)
	]);
	if (/\b(?:on\s+)?the last day of (?:the |each )?month\b/i.test(text)) {
		const startDate = text.match(new RegExp(`\\b(?:starting|beginning|first payment(?: date)?|initial payment(?: date)?)\\s+(?:on|is|date is)?\\s*(${dateValue})`, "i"))?.[1];
		paymentDates.length = 0;
		if (startDate) paymentDates.push(`Starting ${startDate}`);
		paymentDates.push("Last day of each month");
	}
	setIfMissing(result, "processPaymentDate", [...new Set(paymentDates)].join("; "));

	const extractedConfirmation = getBestConfirmationValue(text);
	if (extractedConfirmation && (!result.confirmationNumber || isConfirmationNoise(result.confirmationNumber) || result.confirmationNumber.length < extractedConfirmation.length)) {
		result.confirmationNumber = extractedConfirmation;
	}
}

function analyzeTranscript(rawText) {
	const result = Object.fromEntries(fieldDefinitions.map(({ key }) => [key, ""]));
	let pendingKey = "";

	for (const rawLine of rawText.split(/\r?\n/)) {
		const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
		if (!line) continue;

		let matchedField = false;
		for (const matcher of fieldMatchers) {
			const match = line.match(matcher.valuePattern);
			if (match) {
				assignFieldValue(result, matcher.key, match[1]);
				pendingKey = match[1].trim() ? "" : matcher.key;
				matchedField = true;
				break;
			}
			if (matcher.labelPattern.test(line)) {
				pendingKey = matcher.key;
				matchedField = true;
				break;
			}
		}
		if (matchedField) continue;

		if (pendingKey) {
			const isAnotherFieldLabel = fieldMatchers.some(({ labelPattern }) => labelPattern.test(line));
			if (isAnotherFieldLabel) {
				pendingKey = "";
				continue;
			}
			assignFieldValue(result, pendingKey, line);
			pendingKey = "";
		}
	}

	extractConversationalValues(rawText, result);
	result.paymentCount = normalizePaymentCount(result.paymentCount || "");
	result.ssn = normalizeSsnCandidate(result.ssn || "");
	result.routing = String(result.routing || "").replace(/\D/g, "");
	if (typeof result.withdrawalAccount === "string") result.withdrawalAccount = result.withdrawalAccount.trim();
	if (typeof result.settledReference === "string") result.settledReference = result.settledReference.trim();
	return result;
}

async function analyzeTranscriptWithGemini(rawText) {
	const properties = Object.fromEntries(fieldDefinitions.map(({ key, aliases }) => [key, {
		type: "STRING",
		description: `${aliases[0]}; return an empty string when absent or uncertain.`
	}]));
	const disclosureAuditProperties = {
		disclosureStatus: {
			type: "STRING",
			enum: ["match", "mismatch", "not_found", "uncertain"],
			description: "Whether the spoken payment disclosure matches the same client's configured payment terms."
		},
		disclosureNotes: {
			type: "STRING",
			description: "Brief evidence for the disclosure result; if absent, say no disclosure was found."
		}
	};
	Object.assign(properties, disclosureAuditProperties);
	const additionalClientProperties = Object.fromEntries(fieldDefinitions.map(({ key, aliases }) => [key, {
		type: "STRING",
		description: `${aliases[0]}; return an empty string when absent or uncertain.`
	}]));
	Object.assign(additionalClientProperties, disclosureAuditProperties);
	properties.additionalClients = {
		type: "ARRAY",
		items: {
			type: "OBJECT",
			properties: additionalClientProperties,
			required: [...fieldDefinitions.map(({ key }) => key), ...Object.keys(disclosureAuditProperties)]
		}
	};
	const prompt = [
		"Extract the requested fields for up to three distinct clients from this call transcript. Put the first client's fields in the top-level properties. Put the second and third clients, in order of discussion, in additionalClients. Return an empty array when there are no additional clients. Use only facts explicitly stated; never infer missing SSN, dates, account numbers, or payment details. Return empty strings for missing or uncertain values.",
		"Client name is the debtor/account holder, never the agent or representative. DOB is the client's birth date. SSN may be full 9 digits or only the last 3 or 4 digits, but only when explicitly identified as social security.",
		"Bank is the creditor or financial institution being called, identified by the representative (for example, 'Thank you for calling Bank of America' or 'This is Alex with Axos Bank'). Do not put the client's representation company or law firm here; that belongs in Call from.",
		"Disclosure means the bank/creditor representative's final confirmation that the payment setup was completed, usually a short readback near the end of the call; it is not the long legal authorization, recording notice, or the client's yes/thank-you. Extract that final bank confirmation verbatim, even when it is only one concise sentence. If the bank never confirms the setup, set disclosure to empty, disclosureStatus to not_found, and disclosureNotes to 'Không có xác nhận cuối từ bank (không có disclosure)'. Compare every concrete term in the final bank confirmation against the earlier agreed setup for that same client: payment count, per-payment amount, dates/frequency, and total if stated. Use mismatch if any restated term conflicts, match if the restated terms are consistent, and uncertain if there is too little detail to compare. Do not require the bank to repeat terms it did not state. Put the specific comparison evidence in disclosureNotes. This checks transcript consistency, not legal compliance.",
		"Account/File/Reference settled is the debt or credit-card account being resolved. Account (to withdraw) is the checking/savings/bank account used for ACH; do not confuse the two.",
		"Number to make payment is the number of payments the agent actually agrees to set up, not merely the total number in an offer. If the caller chooses only the first payment, return 1. If the agent sets up multiple tiers, sum their payment counts.",
		"Settlement offer is the stated total settlement. If no total is stated but a complete tiered schedule is explicit, calculate the total as the sum of count times amount for each tier and label it calculated. Amount should list each per-payment amount and count when tiers differ.",
		"Process payment date must list every explicitly stated payment date in chronological order, separated by semicolons, preserving month, day, and year when stated. If multiple payments have different dates, list each date rather than summarizing them. For recurring schedules, include the stated start date and the recurrence rule when available; do not use the call date or invent missing dates. Normalize routing to digits only. Preserve confirmation/reference codes exactly.",
		"Confirmation number may be spoken letter-by-letter such as 'V as in Victor, 3, N as in Nancy, 5, N as in Nancy, F as in Frank, 6, D as in Delta' and should be normalized to a compact alphanumeric code like 'V3N5NF6D'.",
		"Return only the requested JSON object. Do not include explanations or markdown."
	].join("\n");
	const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`);
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
		signal: AbortSignal.timeout(30_000),
		body: JSON.stringify({
			systemInstruction: { parts: [{ text: prompt }] },
			contents: [{ role: "user", parts: [{ text: rawText }] }],
			generationConfig: {
				temperature: 0,
				responseMimeType: "application/json",
				responseSchema: { type: "OBJECT", properties, required: [...fieldDefinitions.map(({ key }) => key), ...Object.keys(disclosureAuditProperties), "additionalClients"] }
			}
		})
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		const providerMessage = String(payload.error?.message || "").replaceAll(process.env.GEMINI_API_KEY, "[redacted]");
		const error = new Error(`Gemini request failed with status ${response.status} for ${GEMINI_MODEL}.${providerMessage ? ` ${providerMessage}` : " Check the API key, model, and quota."}`);
		error.statusCode = response.status === 429 ? 429 : 502;
		throw error;
	}

	const generatedText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
	if (!generatedText) {
		const error = new Error("Gemini returned no structured transcript result.");
		error.statusCode = 502;
		throw error;
	}

	let generated;
	try {
		generated = JSON.parse(generatedText);
	} catch {
		const error = new Error("Gemini returned invalid JSON. Please try again.");
		error.statusCode = 502;
		throw error;
	}

	const normalizeClient = (client) => {
		const normalized = Object.fromEntries(fieldDefinitions.map(({ key }) => [key, typeof client?.[key] === "string" ? client[key].trim().slice(0, key === "disclosure" ? 5000 : 1000) : ""]));
		normalized.paymentCount = normalizePaymentCount(normalized.paymentCount);
		normalized.ssn = normalizeSsnCandidate(normalized.ssn);
		normalized.routing = normalized.routing.replace(/\D/g, "");
		const disclosureStatuses = ["match", "mismatch", "not_found", "uncertain"];
		normalized.disclosureStatus = disclosureStatuses.includes(client?.disclosureStatus)
			? client.disclosureStatus
			: normalized.disclosure ? "uncertain" : "not_found";
		normalized.disclosureNotes = typeof client?.disclosureNotes === "string" ? client.disclosureNotes.trim().slice(0, 1000) : "";
		return normalized;
	};
	const result = normalizeClient(generated);
	result.additionalClients = Array.isArray(generated.additionalClients)
		? generated.additionalClients.slice(0, 2).map(normalizeClient)
		: [];
	return result;
}

function sendJson(response, statusCode, data) {
	const body = JSON.stringify(data);
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	response.end(body);
}

function readJson(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let tooLarge = false;

		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_SIZE) {
				tooLarge = true;
				chunks.length = 0;
			} else if (!tooLarge) {
				chunks.push(chunk);
			}
		});
		request.on("end", () => {
			if (tooLarge) {
				const error = new Error("Transcript vượt quá giới hạn 2 MB.");
				error.statusCode = 413;
				reject(error);
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				const error = new Error("Dữ liệu gửi lên không phải JSON hợp lệ.");
				error.statusCode = 400;
				reject(error);
			}
		});
		request.on("error", reject);
	});
}

async function serveFrontend(request, response, pathname) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		response.writeHead(405, { Allow: "GET, HEAD" });
		response.end("Method not allowed");
		return;
	}

	const relativePath = pathname === "/" ? "/test.html" : pathname;
	const filePath = path.resolve(FRONTEND_DIRECTORY, `.${relativePath}`);
	if (!filePath.startsWith(`${FRONTEND_DIRECTORY}${path.sep}`)) {
		response.writeHead(403);
		response.end("Forbidden");
		return;
	}

	try {
		const content = await fs.readFile(filePath);
		const extension = path.extname(filePath);
		const contentType = extension === ".html" ? "text/html; charset=utf-8"
			: extension === ".css" ? "text/css; charset=utf-8"
				: extension === ".js" ? "text/javascript; charset=utf-8"
					: "application/octet-stream";
		response.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": content.length,
			"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
			"Pragma": "no-cache",
			"Expires": "0",
			"X-Content-Type-Options": "nosniff"
		});
		response.end(request.method === "HEAD" ? undefined : content);
	} catch {
		response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		response.end("Không tìm thấy tệp.");
	}
}

function createServer() {
	return http.createServer(async (request, response) => {
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(request.url, `http://${HOST}`).pathname);
		} catch {
			sendJson(response, 400, { error: "Đường dẫn không hợp lệ." });
			return;
		}

		if (pathname === "/api/health" && request.method === "GET") {
			sendJson(response, 200, { status: "ok", aiEnabled: Boolean(process.env.GEMINI_API_KEY), model: process.env.GEMINI_MODEL || GEMINI_MODEL });
			return;
		}

		if (pathname === "/api/analyze") {
			if (request.method !== "POST") {
				sendJson(response, 405, { error: "API chỉ chấp nhận POST." });
				return;
			}
			try {
				const body = await readJson(request);
				if (typeof body.transcript !== "string" || !body.transcript.trim()) {
					sendJson(response, 400, { error: "Trường transcript không được để trống." });
					return;
				}
				if (!process.env.GEMINI_API_KEY) {
					sendJson(response, 503, { error: "Gemini API key chưa được cấu hình. Hãy khởi động lại server với GEMINI_API_KEY." });
					return;
				}
				const result = await analyzeTranscriptWithGemini(body.transcript.trim());
				sendJson(response, 200, { ...result, processingMode: "gemini" });
			} catch (error) {
				sendJson(response, error.statusCode || 500, { error: error.message || "Không thể xử lý transcript." });
			}
			return;
		}

		await serveFrontend(request, response, pathname);
	});
}

if (require.main === module) {
	createServer().listen(PORT, HOST, () => {
		console.log(`Transcript Desk đang chạy tại http://${HOST}:${PORT}`);
	});
}

module.exports = { analyzeTranscript, createServer };
