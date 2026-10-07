/* =========================================
   AI Extractor — Groq + OpenRouter (Free)
   ========================================= */

const AIExtractor = (() => {

    const PROVIDERS = {
        groq: {
            url: 'https://api.groq.com/openai/v1/chat/completions',
            model: 'openai/gpt-oss-120b',
            name: 'Groq (GPT-OSS 120B)',
        },
        openrouter: {
            url: 'https://openrouter.ai/api/v1/chat/completions',
            model: 'meta-llama/llama-3.3-70b-instruct:free',
            name: 'OpenRouter (Free Llama)',
        },
    };

    const SYSTEM_PROMPT = `You are an expert Indian GST Invoice data extraction system.
Analyze the invoice text and extract all fields into a structured JSON object.
Return ONLY valid JSON — no markdown fences, no explanation.

Required JSON structure:
{
  "invoiceNumber": "",
  "invoiceDate": "",
  "placeOfSupply": "",
  "reverseCharge": "Yes or No or empty",
  "sellerName": "",
  "sellerGstin": "",
  "sellerAddress": "",
  "buyerName": "",
  "buyerGstin": "",
  "buyerAddress": "",
  "cgstRate": "",
  "cgstAmount": "",
  "sgstRate": "",
  "sgstAmount": "",
  "igstRate": "",
  "igstAmount": "",
  "cessAmount": "",
  "taxableValue": "",
  "grandTotal": "",
  "lineItems": [
    { "description": "", "hsn": "", "qty": "", "unit": "", "rate": "", "amount": "" }
  ]
}`;

    const USER_PROMPT_PREFIX = `Extract all invoice fields as JSON from the following invoice text:\n\n`;

    /**
     * Extract fields using Groq or OpenRouter
     */
    async function extract(rawText, apiKey, provider) {
        provider = provider || StorageManager.getProvider();
        if (!apiKey) throw new Error('No API key configured. Add your Groq key in Settings.');
        if (!rawText || rawText.trim().length < 10) throw new Error('Insufficient text for AI extraction.');

        const config = PROVIDERS[provider] || PROVIDERS.groq;
        const truncatedText = rawText.substring(0, 8000);

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = window.location.href;
            headers['X-Title'] = 'InvoiceAI';
        }

        const body = {
            model: config.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: USER_PROMPT_PREFIX + truncatedText }
            ],
            temperature: 0.1,
            max_tokens: 8192,
            ...(provider === 'groq' ? { reasoning_effort: 'low' } : {}),
            response_format: provider === 'groq' ? { type: 'json_object' } : undefined,
        };

        const response = await fetch(config.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData.error?.message || `${config.name} error ${response.status}`;
            if (response.status === 429) {
                throw new Error(`Rate limit on ${config.name}. Wait a minute or switch to OpenRouter in Settings.`);
            }
            if (response.status === 401) throw new Error(`Invalid API key for ${config.name}. Please check Settings.`);
            throw new Error(errMsg);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error(`Empty response from ${config.name}`);

        return parseAndNormalize(content, rawText);
    }

    function parseAndNormalize(content, rawText) {
        let parsed;
        try {
            const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            parsed = JSON.parse(cleaned);
        } catch {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) parsed = JSON.parse(match[0]);
            else throw new Error('AI returned non-JSON response. Try again.');
        }

        const result = FieldExtractor.extract(''); // get blank template
        const fieldMap = {
            invoiceNumber: ['invoiceNumber','invoice_number','invoiceNo'],
            invoiceDate: ['invoiceDate','invoice_date','date'],
            placeOfSupply: ['placeOfSupply','place_of_supply'],
            reverseCharge: ['reverseCharge','reverse_charge'],
            sellerName: ['sellerName','seller_name','supplierName'],
            sellerGstin: ['sellerGstin','seller_gstin','supplierGstin'],
            sellerAddress: ['sellerAddress','seller_address'],
            buyerName: ['buyerName','buyer_name','customerName'],
            buyerGstin: ['buyerGstin','buyer_gstin','customerGstin'],
            buyerAddress: ['buyerAddress','buyer_address'],
            cgstRate: ['cgstRate','cgst_rate'],
            cgstAmount: ['cgstAmount','cgst_amount'],
            sgstRate: ['sgstRate','sgst_rate'],
            sgstAmount: ['sgstAmount','sgst_amount'],
            igstRate: ['igstRate','igst_rate'],
            igstAmount: ['igstAmount','igst_amount'],
            cessAmount: ['cessAmount','cess_amount','cess'],
            taxableValue: ['taxableValue','taxable_value','subtotal'],
            grandTotal: ['grandTotal','grand_total','totalAmount','total'],
        };

        for (const [key, aliases] of Object.entries(fieldMap)) {
            for (const a of aliases) {
                if (parsed[a] !== undefined && String(parsed[a]).trim()) {
                    result[key] = String(parsed[a]).trim();
                    break;
                }
            }
        }

        const items = parsed.lineItems || parsed.line_items || parsed.items || [];
        if (Array.isArray(items) && items.length > 0) {
            result.lineItems = items.map(item => ({
                description: String(item.description || item.desc || item.name || '').trim(),
                hsn: String(item.hsn || item.hsnSac || item.hsn_sac || '').trim(),
                qty: String(item.qty || item.quantity || '').trim(),
                unit: String(item.unit || item.uom || '').trim(),
                rate: String(item.rate || item.unitPrice || item.price || '').replace(/,/g, '').trim(),
                amount: String(item.amount || item.total || item.value || '').replace(/,/g, '').trim(),
            })).filter(i => i.description || i.amount);
        }

        result.rawText = rawText;
        return result;
    }

    function mergeResults(regexResult, aiResult) {
        const merged = { ...regexResult };
        for (const [key, value] of Object.entries(aiResult)) {
            if (key === 'lineItems') {
                if (Array.isArray(value) && value.length > 0 &&
                    (!merged.lineItems || value.length >= merged.lineItems.length)) {
                    merged.lineItems = value;
                }
            } else if (key !== 'rawText' && value && typeof value === 'string' && value.trim()) {
                merged[key] = value.trim();
            }
        }
        return merged;
    }

    return { extract, mergeResults, PROVIDERS };
})();
