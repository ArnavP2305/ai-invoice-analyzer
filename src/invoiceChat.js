/* =========================================
   Invoice Chat — Groq + OpenRouter (Free)
   ========================================= */

const InvoiceChat = (() => {

    const PROVIDERS = {
        groq: {
            url: 'https://api.groq.com/openai/v1/chat/completions',
            model: 'openai/gpt-oss-120b',
            name: 'Groq',
        },
        openrouter: {
            url: 'https://openrouter.ai/api/v1/chat/completions',
            model: 'meta-llama/llama-3.3-70b-instruct:free',
            name: 'OpenRouter',
        },
    };

    let conversationHistory = [];

    function buildSystemPrompt(invoiceData) {
        const fields = [];
        if (invoiceData.invoiceNumber) fields.push(`Invoice Number: ${invoiceData.invoiceNumber}`);
        if (invoiceData.invoiceDate)   fields.push(`Invoice Date: ${invoiceData.invoiceDate}`);
        if (invoiceData.placeOfSupply) fields.push(`Place of Supply: ${invoiceData.placeOfSupply}`);
        if (invoiceData.reverseCharge) fields.push(`Reverse Charge: ${invoiceData.reverseCharge}`);
        if (invoiceData.sellerName)    fields.push(`Seller Name: ${invoiceData.sellerName}`);
        if (invoiceData.sellerGstin)   fields.push(`Seller GSTIN: ${invoiceData.sellerGstin}`);
        if (invoiceData.sellerAddress) fields.push(`Seller Address: ${invoiceData.sellerAddress}`);
        if (invoiceData.buyerName)     fields.push(`Buyer Name: ${invoiceData.buyerName}`);
        if (invoiceData.buyerGstin)    fields.push(`Buyer GSTIN: ${invoiceData.buyerGstin}`);
        if (invoiceData.buyerAddress)  fields.push(`Buyer Address: ${invoiceData.buyerAddress}`);
        if (invoiceData.cgstRate)      fields.push(`CGST Rate: ${invoiceData.cgstRate}%`);
        if (invoiceData.cgstAmount)    fields.push(`CGST Amount: ₹${invoiceData.cgstAmount}`);
        if (invoiceData.sgstRate)      fields.push(`SGST Rate: ${invoiceData.sgstRate}%`);
        if (invoiceData.sgstAmount)    fields.push(`SGST Amount: ₹${invoiceData.sgstAmount}`);
        if (invoiceData.igstRate)      fields.push(`IGST Rate: ${invoiceData.igstRate}%`);
        if (invoiceData.igstAmount)    fields.push(`IGST Amount: ₹${invoiceData.igstAmount}`);
        if (invoiceData.cessAmount)    fields.push(`Cess: ₹${invoiceData.cessAmount}`);
        if (invoiceData.taxableValue)  fields.push(`Taxable Value: ₹${invoiceData.taxableValue}`);
        if (invoiceData.grandTotal)    fields.push(`Grand Total: ₹${invoiceData.grandTotal}`);

        let lineItemsStr = '';
        if (invoiceData.lineItems && invoiceData.lineItems.length > 0) {
            lineItemsStr = '\n\nLine Items:\n';
            invoiceData.lineItems.forEach((item, i) => {
                lineItemsStr += `${i + 1}. ${item.description || 'N/A'}`;
                if (item.hsn) lineItemsStr += ` (HSN: ${item.hsn})`;
                if (item.qty) lineItemsStr += ` | Qty: ${item.qty}`;
                if (item.rate) lineItemsStr += ` | Rate: ₹${item.rate}`;
                if (item.amount) lineItemsStr += ` | Amount: ₹${item.amount}`;
                lineItemsStr += '\n';
            });
        }

        const complianceStr = invoiceData.complianceScore !== undefined
            ? `\nGST Compliance Score: ${invoiceData.complianceScore}% (${invoiceData.complianceLabel || ''})`
            : '';

        return `You are an expert Indian GST Invoice Analyst AI. Help users understand their invoices and check GST compliance.

INVOICE DATA:
${fields.join('\n')}${lineItemsStr}${complianceStr}

RAW TEXT (first 4000 chars):
${(invoiceData.rawText || '').substring(0, 4000)}

RULES:
- Answer from the invoice data above. Be concise and use bullet points.
- Use ₹ for amounts. Reference GST Rule 46 for compliance questions.
- If data is missing, say so clearly. Keep replies under 350 words.`;
    }

    async function sendMessage(userMessage, invoiceData, apiKey) {
        if (!apiKey) throw new Error('Please add your Groq API key in Settings (click ⚙ API Key).');
        if (!userMessage.trim()) throw new Error('Please enter a question.');

        const provider = StorageManager.getProvider();
        const config = PROVIDERS[provider] || PROVIDERS.groq;
        const systemPrompt = buildSystemPrompt(invoiceData);

        // Build messages with history
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: userMessage }
        ];

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        };
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = window.location.href;
            headers['X-Title'] = 'InvoiceAI';
        }

        const response = await fetch(config.url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: config.model,
                messages,
                temperature: 0.3,
                max_tokens: 4096,
                ...(provider === 'groq' ? { reasoning_effort: 'low' } : {}),
            }),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            if (response.status === 429) {
                throw new Error(`Rate limit on ${config.name}. Wait a moment or switch to OpenRouter in Settings.`);
            }
            if (response.status === 401) throw new Error(`Invalid API key. Please check your key in Settings.`);
            throw new Error(errData.error?.message || `${config.name} error ${response.status}`);
        }

        const data = await response.json();
        const aiText = data.choices?.[0]?.message?.content;
        if (!aiText) throw new Error('Empty response from AI. Please try again.');

        // Save to history (keep last 10 turns = 20 messages)
        conversationHistory.push({ role: 'user', content: userMessage });
        conversationHistory.push({ role: 'assistant', content: aiText });
        if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);

        return aiText;
    }

    function clearHistory() {
        conversationHistory = [];
    }

    function formatResponse(text) {
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>');

        // Convert markdown bullets to HTML list
        const lines = html.split('\n');
        let inList = false;
        const result = [];
        for (const line of lines) {
            const isBullet = /^\s*[-•*]\s+/.test(line);
            if (isBullet && !inList) { result.push('<ul>'); inList = true; }
            if (!isBullet && inList) { result.push('</ul>'); inList = false; }
            if (isBullet) {
                result.push('<li>' + line.replace(/^\s*[-•*]\s+/, '') + '</li>');
            } else {
                result.push(line ? line + '<br>' : '<br>');
            }
        }
        if (inList) result.push('</ul>');
        return result.join('');
    }

    return { sendMessage, clearHistory, formatResponse };
})();
