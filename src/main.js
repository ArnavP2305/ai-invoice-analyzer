/* =========================================
   Main Application — InvoiceAI Controller
   ========================================= */

(function () {
    'use strict';

    // ---- State ----
    let fileQueue = [];        // { id, file, name, size, type, status }
    let batchResults = [];     // Array of extracted data (one per invoice)
    let currentResultIndex = 0;
    let isProcessing = false;

    // ---- DOM Refs ----
    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);

    // Sections
    const uploadSection = $('upload-section');
    const processingSection = $('processing-section');
    const resultsSection = $('results-section');
    const historySection = $('history-section');

    // Upload
    const uploadZone = $('upload-zone');
    const fileInput = $('file-input');
    const fileQueueEl = $('file-queue');
    const fileListEl = $('file-list');

    // Processing
    const progressFill = $('progress-fill');
    const progressText = $('progress-text');
    const processingFilename = $('processing-filename');
    const processingStage = $('processing-stage');
    const processingLog = $('processing-log');

    // Results fields
    const fieldIds = [
        'field-invoice-number', 'field-invoice-date', 'field-place-of-supply', 'field-reverse-charge',
        'field-seller-name', 'field-seller-gstin', 'field-seller-address',
        'field-buyer-name', 'field-buyer-gstin', 'field-buyer-address',
        'field-cgst-rate', 'field-cgst-amount', 'field-sgst-rate', 'field-sgst-amount',
        'field-igst-rate', 'field-igst-amount', 'field-cess-amount',
        'field-taxable-value', 'field-grand-total',
    ];

    // ---- Init ----
    document.addEventListener('DOMContentLoaded', () => {
        initEventListeners();
        loadSettings();
        addScoreGradientDef();
    });

    function addScoreGradientDef() {
        // Inject SVG gradient for score ring
        const svg = document.querySelector('.compliance-score-ring svg');
        if (svg) {
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            defs.innerHTML = `
                <linearGradient id="score-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#a78bfa"/>
                    <stop offset="100%" stop-color="#06b6d4"/>
                </linearGradient>
            `;
            svg.prepend(defs);
        }
    }

    // ---- Event Listeners ----
    function initEventListeners() {
        // Upload Zone
        uploadZone.addEventListener('click', () => fileInput.click());
        uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
        uploadZone.addEventListener('drop', e => {
            e.preventDefault();
            uploadZone.classList.remove('drag-over');
            handleFiles(e.dataTransfer.files);
        });
        fileInput.addEventListener('change', e => {
            handleFiles(e.target.files);
            fileInput.value = '';
        });

        // Queue actions
        $('btn-clear-queue').addEventListener('click', clearQueue);
        $('btn-process-all').addEventListener('click', processAll);

        // Results actions
        $('btn-new-upload').addEventListener('click', showUpload);
        $('btn-export-json').addEventListener('click', () => {
            const data = getCurrentData();
            if (data) ExportManager.exportJSON(data, data.filename || 'invoice');
        });
        $('btn-export-csv').addEventListener('click', () => {
            const data = getCurrentData();
            if (data) ExportManager.exportCSV(data, data.filename || 'invoice');
        });
        $('btn-save').addEventListener('click', saveCurrentInvoice);
        $('btn-add-item').addEventListener('click', addLineItemRow);

        // GSTIN validation on input
        $('field-seller-gstin').addEventListener('input', () => validateGSTINField('field-seller-gstin', 'val-seller-gstin'));
        $('field-buyer-gstin').addEventListener('input', () => validateGSTINField('field-buyer-gstin', 'val-buyer-gstin'));

        // Header buttons
        if ($('btn-api-settings')) $('btn-api-settings').addEventListener('click', showApiModal);
        if ($('btn-history')) $('btn-history').addEventListener('click', showHistory);

        // Modal
        $('btn-close-modal').addEventListener('click', hideApiModal);
        $('btn-save-api').addEventListener('click', saveApiSettings);
        $('input-api-key-groq').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiSettings(); });
        $('api-modal').addEventListener('click', e => { if (e.target === $('api-modal')) hideApiModal(); });
        // Provider switcher
        $('select-provider').addEventListener('change', () => {
            const p = $('select-provider').value;
            document.querySelectorAll('.provider-config').forEach(el => el.classList.add('hidden'));
            const cfg = $('config-' + p);
            if (cfg) cfg.classList.remove('hidden');
        });

        // History (Legacy / Fallback checks)
        if ($('btn-back-to-upload')) $('btn-back-to-upload').addEventListener('click', showUpload);
        if ($('btn-clear-history')) {
            $('btn-clear-history').addEventListener('click', async () => {
                if (confirm('Are you sure you want to delete all saved invoices?')) {
                    await StorageManager.clearHistory();
                    if (typeof renderHistory === 'function') await renderHistory();
                    showToast('History cleared', 'info');
                }
            });
        }
        if ($('btn-export-all-history')) {
            $('btn-export-all-history').addEventListener('click', async () => {
                const history = await StorageManager.getHistory();
                if (history.length === 0) return showToast('No history to export', 'info');
                ExportManager.exportAllJSON(history);
                showToast('Exported all invoices', 'success');
            });
        }

        // Chat
        $('btn-chat-send').addEventListener('click', handleChatSend);
        $('chat-input').addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleChatSend();
            }
        });
        // Suggestion buttons
        document.querySelectorAll('.chat-suggestion').forEach(btn => {
            btn.addEventListener('click', () => {
                const question = btn.dataset.q;
                if (question) {
                    $('chat-input').value = question;
                    handleChatSend();
                }
            });
        });
    }

    // ---- File Handling ----
    const ALLOWED_TYPES = [
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff',
    ];
    const MAX_SIZE = 25 * 1024 * 1024; // 25MB

    function handleFiles(files) {
        const newFiles = Array.from(files).filter(f => {
            if (!ALLOWED_TYPES.includes(f.type)) {
                showToast(`Unsupported file: ${f.name}`, 'error');
                return false;
            }
            if (f.size > MAX_SIZE) {
                showToast(`File too large (>25MB): ${f.name}`, 'error');
                return false;
            }
            return true;
        });

        for (const f of newFiles) {
            fileQueue.push({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
                file: f,
                name: f.name,
                size: f.size,
                type: f.type,
                status: 'pending',
            });
        }

        if (fileQueue.length > 0) {
            renderQueue();
            fileQueueEl.classList.remove('hidden');
        }
    }

    function renderQueue() {
        fileListEl.innerHTML = '';
        for (const item of fileQueue) {
            const isPdf = item.type === 'application/pdf';
            const sizeStr = formatSize(item.size);
            const div = document.createElement('div');
            div.className = 'file-item';
            div.id = `queue-${item.id}`;
            div.innerHTML = `
                <div class="file-item-icon ${isPdf ? 'pdf' : 'img'}">${isPdf ? 'PDF' : 'IMG'}</div>
                <div class="file-item-info">
                    <div class="file-item-name">${escapeHtml(item.name)}</div>
                    <div class="file-item-meta">${sizeStr}</div>
                </div>
                <span class="file-item-status status-${item.status}">${statusLabel(item.status)}</span>
                <button class="file-item-remove" data-id="${item.id}" title="Remove">×</button>
            `;
            div.querySelector('.file-item-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                removeFromQueue(item.id);
            });
            fileListEl.appendChild(div);
        }
    }

    function removeFromQueue(id) {
        fileQueue = fileQueue.filter(f => f.id !== id);
        if (fileQueue.length === 0) {
            fileQueueEl.classList.add('hidden');
        }
        renderQueue();
    }

    function clearQueue() {
        fileQueue = [];
        fileQueueEl.classList.add('hidden');
        fileListEl.innerHTML = '';
    }

    // ---- Processing Pipeline ----
    async function processAll() {
        if (isProcessing || fileQueue.length === 0) return;
        isProcessing = true;
        batchResults = [];

        const mode = StorageManager.getMode();
        const provider = StorageManager.getProvider();
        const apiKey = StorageManager.getActiveApiKey();

        if ((mode === 'ai' || mode === 'hybrid') && !apiKey) {
            const providerNames = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' };
            showToast(`Please configure your ${providerNames[provider] || 'AI'} API key in Settings`, 'error');
            showApiModal();
            isProcessing = false;
            return;
        }

        showSection('processing');

        for (let i = 0; i < fileQueue.length; i++) {
            const item = fileQueue[i];
            item.status = 'processing';
            renderQueue();

            processingFilename.textContent = `${item.name} (${i + 1}/${fileQueue.length})`;

            try {
                const result = await processFile(item.file, item.name, mode, apiKey, provider);
                result.filename = item.name;
                result.fileSize = item.size;
                result.processedAt = new Date().toISOString();

                // Run compliance check
                const compliance = GSTValidator.checkCompliance(result);
                result.complianceScore = compliance.score;
                result.complianceLabel = compliance.label;
                result.complianceChecks = compliance.checks;

                batchResults.push(result);
                item.status = 'done';
            } catch (err) {
                console.error(`Error processing ${item.name}:`, err);
                item.status = 'error';
                logProcessing(`❌ Error: ${err.message}`, true);
                showToast(`Failed to process ${item.name}: ${err.message}`, 'error');
            }

            renderQueue();
        }

        isProcessing = false;

        if (batchResults.length > 0) {
            currentResultIndex = 0;
            showSection('results');
            renderBatchTabs();
            displayResult(0);
            showToast(`Successfully processed ${batchResults.length} invoice(s)`, 'success');
        } else {
            showToast('No invoices were successfully processed', 'error');
            showSection('upload');
        }
    }

    async function processFile(file, filename, mode, apiKey, provider) {
        const isPdf = file.type === 'application/pdf';
        let rawText = '';

        resetProcessingUI();

        if (isPdf) {
            logProcessing('📄 Detected PDF file');
            setProgress(5, 'Parsing PDF...');

            try {
                const pdfResult = await PDFParser.extractText(file, (msg, pct) => {
                    setProgress(5 + pct * 0.3, msg);
                    logProcessing(msg);
                });

                rawText = pdfResult.text;
                logProcessing(`📝 Extracted ${rawText.length} characters from ${pdfResult.pageCount} page(s)`);

                if (pdfResult.isScanned) {
                    logProcessing('🔍 PDF appears to be scanned — running OCR...');
                    setProgress(40, 'Converting PDF pages to images...');

                    const images = await PDFParser.convertToImages(file, (msg, pct) => {
                        setProgress(40 + pct * 0.15, msg);
                        logProcessing(msg);
                    });

                    setProgress(55, 'Running OCR on scanned pages...');
                    const ocrText = await OCREngine.recognizeMultiple(images, (msg, pct) => {
                        setProgress(55 + pct * 0.25, msg);
                        logProcessing(msg);
                    });

                    rawText = ocrText;
                    logProcessing(`📝 OCR extracted ${rawText.length} characters`);
                }
            } catch (err) {
                logProcessing(`⚠️ PDF parsing failed, trying OCR fallback...`);
                // Try OCR as complete fallback
                const images = await PDFParser.convertToImages(file, (msg) => logProcessing(msg));
                rawText = await OCREngine.recognizeMultiple(images, (msg, pct) => {
                    setProgress(30 + pct * 0.5, msg);
                    logProcessing(msg);
                });
            }
        } else {
            // Image file — use OCR directly
            logProcessing('🖼️ Detected image file — running OCR...');
            setProgress(10, 'Running OCR...');

            rawText = await OCREngine.recognize(file, (msg, pct) => {
                setProgress(10 + pct * 0.7, msg);
                logProcessing(msg);
            });

            logProcessing(`📝 OCR extracted ${rawText.length} characters`);
        }

        if (!rawText || rawText.trim().length < 5) {
            throw new Error('Could not extract any text from the file. Please try a clearer image/PDF.');
        }

        // Field Extraction
        setProgress(85, 'Extracting invoice fields...');
        logProcessing('🔎 Running field extraction...');

        let result;

        if (mode === 'regex' || !apiKey) {
            result = FieldExtractor.extract(rawText);
            logProcessing('✅ Regex extraction complete');
        } else if (mode === 'ai') {
            const providerName = provider === 'groq' ? 'Groq (GPT-OSS 120B)' : 'OpenRouter';
            logProcessing(`🤖 Sending to ${providerName} for extraction...`);
            setProgress(88, 'AI extraction in progress...');
            try {
                result = await AIExtractor.extract(rawText, apiKey, provider);
                result.rawText = rawText;
                logProcessing('✅ AI extraction complete');
            } catch (err) {
                logProcessing(`⚠️ AI extraction failed: ${err.message}. Falling back to regex.`);
                result = FieldExtractor.extract(rawText);
            }
        } else if (mode === 'hybrid') {
            const regexResult = FieldExtractor.extract(rawText);
            logProcessing('✅ Regex extraction complete');
            const providerName = provider === 'groq' ? 'Groq (GPT-OSS 120B)' : 'OpenRouter';
            logProcessing(`🤖 Sending to ${providerName} for enhanced extraction...`);
            setProgress(88, 'AI verification...');
            try {
                const aiResult = await AIExtractor.extract(rawText, apiKey, provider);
                result = AIExtractor.mergeResults(regexResult, aiResult);
                result.rawText = rawText;
                logProcessing('✅ Hybrid extraction complete (Regex + AI merged)');
            } catch (err) {
                logProcessing(`⚠️ AI enhancement failed: ${err.message}. Using regex results.`);
                result = regexResult;
            }
        }

        setProgress(100, 'Done!');
        logProcessing('🎉 Processing complete');

        return result;
    }

    // ---- UI Updates ----
    function showSection(name) {
        uploadSection.classList.remove('visible');
        uploadSection.classList.add('hidden');
        processingSection.classList.add('hidden');
        resultsSection.classList.add('hidden');
        historySection.classList.add('hidden');
        $('dashboard-section').classList.add('hidden');

        switch (name) {
            case 'upload':
                uploadSection.classList.remove('hidden');
                uploadSection.classList.add('visible');
                break;
            case 'processing':
                processingSection.classList.remove('hidden');
                processingSection.classList.add('visible');
                break;
            case 'results':
                resultsSection.classList.remove('hidden');
                resultsSection.classList.add('visible');
                break;
            case 'history':
                historySection.classList.remove('hidden');
                historySection.classList.add('visible');
                break;
            case 'dashboard':
                $('dashboard-section').classList.remove('hidden');
                $('dashboard-section').classList.add('visible');
                break;
        }
    }

    function showUpload() {
        fileQueue = [];
        batchResults = [];
        clearQueue();
        showSection('upload');
    }

    function setProgress(percent, label) {
        progressFill.style.width = `${Math.min(100, percent)}%`;
        progressText.textContent = `${Math.round(percent)}%`;
        if (label) {
            processingStage.innerHTML = `<div class="stage-icon spinner"></div><span>${escapeHtml(label)}</span>`;
        }
    }

    function resetProcessingUI() {
        setProgress(0, 'Initializing...');
        processingLog.innerHTML = '';
    }

    function logProcessing(message, isError) {
        const p = document.createElement('p');
        p.textContent = message;
        if (isError) p.style.color = '#f43f5e';
        processingLog.appendChild(p);
        processingLog.scrollTop = processingLog.scrollHeight;
    }

    // ---- Batch Tabs ----
    function renderBatchTabs() {
        const container = $('batch-tabs');
        if (batchResults.length <= 1) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');
        container.innerHTML = '';

        batchResults.forEach((result, i) => {
            const btn = document.createElement('button');
            btn.className = `batch-tab ${i === currentResultIndex ? 'active' : ''}`;
            btn.textContent = result.filename || `Invoice ${i + 1}`;
            btn.addEventListener('click', () => {
                currentResultIndex = i;
                displayResult(i);
                renderBatchTabs();
            });
            container.appendChild(btn);
        });
    }

    // ---- Display Result ----
    function displayResult(index) {
        const data = batchResults[index];
        if (!data) return;

        // Populate fields
        $('field-invoice-number').value = data.invoiceNumber || '';
        $('field-invoice-date').value = data.invoiceDate || '';
        $('field-place-of-supply').value = data.placeOfSupply || '';
        $('field-reverse-charge').value = data.reverseCharge || '';
        $('field-seller-name').value = data.sellerName || '';
        $('field-seller-gstin').value = data.sellerGstin || '';
        $('field-seller-address').value = data.sellerAddress || '';
        $('field-buyer-name').value = data.buyerName || '';
        $('field-buyer-gstin').value = data.buyerGstin || '';
        $('field-buyer-address').value = data.buyerAddress || '';
        $('field-cgst-rate').value = data.cgstRate || '';
        $('field-cgst-amount').value = data.cgstAmount || '';
        $('field-sgst-rate').value = data.sgstRate || '';
        $('field-sgst-amount').value = data.sgstAmount || '';
        $('field-igst-rate').value = data.igstRate || '';
        $('field-igst-amount').value = data.igstAmount || '';
        $('field-cess-amount').value = data.cessAmount || '';
        $('field-taxable-value').value = data.taxableValue || '';
        $('field-grand-total').value = data.grandTotal || '';

        // Validate GSTINs
        validateGSTINField('field-seller-gstin', 'val-seller-gstin');
        validateGSTINField('field-buyer-gstin', 'val-buyer-gstin');

        // Line Items
        renderLineItems(data.lineItems || []);

        // Raw Text
        $('raw-text-output').textContent = data.rawText || '(No text extracted)';

        // Compliance
        renderCompliance(data);

        // Reset chat for new invoice
        resetChat();

        // Update subtitle
        $('results-subtitle').textContent = `${data.filename || 'Invoice'} — processed ${formatTimeAgo(data.processedAt)}`;
    }

    function renderLineItems(items) {
        const tbody = $('items-tbody');
        const noItemsMsg = $('no-items-msg');
        tbody.innerHTML = '';

        if (items.length === 0) {
            noItemsMsg.style.display = 'block';
            return;
        }

        noItemsMsg.style.display = 'none';

        items.forEach((item, i) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${i + 1}</td>
                <td><input type="text" value="${escapeAttr(item.description)}" data-row="${i}" data-field="description"></td>
                <td><input type="text" value="${escapeAttr(item.hsn)}" data-row="${i}" data-field="hsn" style="width:80px"></td>
                <td><input type="text" value="${escapeAttr(item.qty)}" data-row="${i}" data-field="qty" style="width:60px"></td>
                <td><input type="text" value="${escapeAttr(item.unit)}" data-row="${i}" data-field="unit" style="width:60px"></td>
                <td><input type="text" value="${escapeAttr(item.rate)}" data-row="${i}" data-field="rate" style="width:80px"></td>
                <td><input type="text" value="${escapeAttr(item.amount)}" data-row="${i}" data-field="amount" style="width:90px"></td>
                <td><button class="btn-danger-sm" data-row="${i}">×</button></td>
            `;

            // Update data on input change
            tr.querySelectorAll('input').forEach(inp => {
                inp.addEventListener('change', () => {
                    const row = parseInt(inp.dataset.row);
                    const field = inp.dataset.field;
                    if (batchResults[currentResultIndex] && batchResults[currentResultIndex].lineItems[row]) {
                        batchResults[currentResultIndex].lineItems[row][field] = inp.value;
                    }
                });
            });

            // Delete row
            tr.querySelector('.btn-danger-sm').addEventListener('click', () => {
                if (batchResults[currentResultIndex]) {
                    batchResults[currentResultIndex].lineItems.splice(i, 1);
                    renderLineItems(batchResults[currentResultIndex].lineItems);
                }
            });

            tbody.appendChild(tr);
        });
    }

    function addLineItemRow() {
        if (!batchResults[currentResultIndex]) return;
        if (!batchResults[currentResultIndex].lineItems) {
            batchResults[currentResultIndex].lineItems = [];
        }
        batchResults[currentResultIndex].lineItems.push({
            description: '', hsn: '', qty: '', unit: '', rate: '', amount: '',
        });
        renderLineItems(batchResults[currentResultIndex].lineItems);

        // Focus the new row's description field
        const lastInput = $('items-tbody').querySelector('tr:last-child td:nth-child(2) input');
        if (lastInput) lastInput.focus();
    }

    // ---- Compliance ----
    function renderCompliance(data) {
        const compliance = GSTValidator.checkCompliance(data);

        // Score ring animation
        const circle = $('score-circle');
        const circumference = 2 * Math.PI * 42; // r=42
        const offset = circumference - (compliance.score / 100) * circumference;
        circle.style.strokeDasharray = circumference;
        // Delay animation slightly for visual effect
        setTimeout(() => {
            circle.style.strokeDashoffset = offset;
        }, 100);

        // Score value
        animateNumber($('score-value'), compliance.score);

        // Labels
        $('compliance-title').textContent = compliance.label;
        const desc = compliance.score >= 90 ? 'All mandatory GST fields are present and valid.'
            : compliance.score >= 70 ? 'Most fields are present. Review warnings below.'
            : compliance.score >= 50 ? 'Several mandatory fields are missing or invalid.'
            : 'Significant compliance issues detected. Please review.';
        $('compliance-desc').textContent = desc;

        // Issues
        const issuesEl = $('compliance-issues');
        issuesEl.innerHTML = '';
        for (const check of compliance.checks) {
            const chip = document.createElement('span');
            chip.className = `issue-chip ${check.status}`;
            const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
            chip.textContent = `${icon} ${check.field}`;
            chip.title = check.msg;
            issuesEl.appendChild(chip);
        }
    }

    function animateNumber(el, target) {
        let current = 0;
        const step = Math.max(1, Math.ceil(target / 40));
        const timer = setInterval(() => {
            current += step;
            if (current >= target) {
                current = target;
                clearInterval(timer);
            }
            el.textContent = current;
        }, 25);
    }

    // ---- GSTIN Validation ----
    function validateGSTINField(inputId, validationId) {
        const input = $(inputId);
        const valEl = $(validationId);
        const value = input.value.trim();

        if (!value) {
            valEl.textContent = '';
            valEl.className = 'field-validation';
            return;
        }

        const result = GSTValidator.validateGSTIN(value);
        valEl.textContent = result.message;
        valEl.className = `field-validation ${result.valid ? 'valid' : 'invalid'}`;
    }

    // ---- Save & History ----
    function getCurrentData() {
        if (!batchResults[currentResultIndex]) return null;

        // Sync form values back to data
        const data = batchResults[currentResultIndex];
        data.invoiceNumber = $('field-invoice-number').value;
        data.invoiceDate = $('field-invoice-date').value;
        data.placeOfSupply = $('field-place-of-supply').value;
        data.reverseCharge = $('field-reverse-charge').value;
        data.sellerName = $('field-seller-name').value;
        data.sellerGstin = $('field-seller-gstin').value;
        data.sellerAddress = $('field-seller-address').value;
        data.buyerName = $('field-buyer-name').value;
        data.buyerGstin = $('field-buyer-gstin').value;
        data.buyerAddress = $('field-buyer-address').value;
        data.cgstRate = $('field-cgst-rate').value;
        data.cgstAmount = $('field-cgst-amount').value;
        data.sgstRate = $('field-sgst-rate').value;
        data.sgstAmount = $('field-sgst-amount').value;
        data.igstRate = $('field-igst-rate').value;
        data.igstAmount = $('field-igst-amount').value;
        data.cessAmount = $('field-cess-amount').value;
        data.taxableValue = $('field-taxable-value').value;
        data.grandTotal = $('field-grand-total').value;

        // Recalc compliance after edit
        const compliance = GSTValidator.checkCompliance(data);
        data.complianceScore = compliance.score;
        data.complianceLabel = compliance.label;

        return data;
    }

    async function saveCurrentInvoice() {
        const data = getCurrentData();
        if (!data) return showToast('No invoice data to save', 'error');

        try {
            await StorageManager.saveInvoice(data);
            showToast('Invoice saved to database securely', 'success');
        } catch(e) {
            showToast(e.message, 'error');
            if(e.message.includes('log in')) {
                const modal = $('auth-modal');
                if(modal) modal.classList.remove('hidden');
            }
        }
    }

    async function showHistory() {
        showSection('history');
        await renderHistory();
    }

    async function renderHistory() {
        const history = await StorageManager.getHistory();
        const listEl = $('history-list');
        const noMsg = $('no-history-msg');

        listEl.innerHTML = '';

        if (history.length === 0) {
            noMsg.style.display = 'block';
            return;
        }

        noMsg.style.display = 'none';

        for (const entry of history) {
            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = `
                <div class="history-item-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </div>
                <div class="history-item-info">
                    <div class="history-item-name">${escapeHtml(entry.filename)}</div>
                    <div class="history-item-details">
                        ${formatTimeAgo(entry.processedAt)} · 
                        ${entry.data?.sellerName ? escapeHtml(entry.data.sellerName) : 'Unknown seller'} · 
                        ₹${entry.data?.grandTotal || '—'}
                    </div>
                </div>
                <span class="history-item-score">${entry.complianceScore}%</span>
                <div class="history-item-actions">
                    <button class="btn-sm btn-ghost btn-load" title="Load">View</button>
                    <button class="btn-danger-sm btn-del" title="Delete">×</button>
                </div>
            `;

            div.querySelector('.btn-load').addEventListener('click', (e) => {
                e.stopPropagation();
                loadFromHistory(entry);
            });

            div.querySelector('.btn-del').addEventListener('click', async (e) => {
                e.stopPropagation();
                await StorageManager.deleteInvoice(entry.id);
                await renderHistory();
                showToast('Invoice deleted', 'info');
            });

            listEl.appendChild(div);
        }
    }

    function loadFromHistory(entry) {
        batchResults = [entry.data];
        currentResultIndex = 0;
        showSection('results');
        renderBatchTabs();
        displayResult(0);
    }

    // ---- API Modal ----
    function loadSettings() {
        const provider = StorageManager.getProvider();
        $('select-provider').value = provider;
        $('input-api-key-groq').value = StorageManager.getApiKey('groq');
        $('input-api-key-openrouter').value = StorageManager.getApiKey('openrouter');
        $('select-mode').value = StorageManager.getMode();
        // Show correct provider config panel
        document.querySelectorAll('.provider-config').forEach(el => el.classList.add('hidden'));
        const cfg = $('config-' + provider);
        if (cfg) cfg.classList.remove('hidden');
    }

    function showApiModal() {
        loadSettings();
        $('api-modal').classList.remove('hidden');
    }

    function hideApiModal() {
        $('api-modal').classList.add('hidden');
    }

    function saveApiSettings() {
        try {
            const provider = $('select-provider').value;
            const mode = $('select-mode').value;
            StorageManager.setProvider(provider);
            StorageManager.setApiKey('groq', $('input-api-key-groq').value.trim());
            
            const routerEl = $('input-api-key-openrouter');
            if (routerEl) {
                StorageManager.setApiKey('openrouter', routerEl.value.trim());
            }
            StorageManager.setMode(mode);
            hideApiModal();
            const providerLabel = { groq: 'Groq', openrouter: 'OpenRouter' }[provider] || provider;
            showToast(`Settings saved — ${providerLabel} · ${mode === 'regex' ? 'Regex Only' : mode === 'ai' ? 'AI-Powered' : 'Hybrid'}`, 'success');
        } catch (e) {
            console.error(e);
            alert("Error saving API keys: " + e.message);
        }
    }

    // ---- AI Chat ----
    let chatBusy = false;

    function resetChat() {
        InvoiceChat.clearHistory();
        const messagesEl = $('chat-messages');
        // Show welcome screen again
        messagesEl.innerHTML = '';
        const welcome = document.querySelector('#card-ai-chat .chat-welcome');
        if (!welcome) {
            // Rebuild welcome
            messagesEl.innerHTML = `
                <div class="chat-welcome">
                    <div class="chat-welcome-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z"/><path d="M8 14s-4 0-4 4v2h16v-2c0-4-4-4-4-4"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/></svg>
                    </div>
                    <h4>AI Invoice Assistant</h4>
                    <p>Ask me anything about this invoice! Try questions like:</p>
                    <div class="chat-suggestions">
                        <button class="chat-suggestion" data-q="Summarize this invoice in simple terms">📋 Summarize this invoice</button>
                        <button class="chat-suggestion" data-q="Is this invoice GST compliant? List any issues.">✅ Check GST compliance</button>
                        <button class="chat-suggestion" data-q="What is the total tax amount and breakdown?">💰 Tax breakdown</button>
                        <button class="chat-suggestion" data-q="Who is the seller and buyer in this invoice?">👥 Seller & Buyer details</button>
                        <button class="chat-suggestion" data-q="Are there any discrepancies or unusual items in this invoice?">🔍 Find discrepancies</button>
                        <button class="chat-suggestion" data-q="Generate a one-line description for accounting entry">📒 Accounting entry</button>
                    </div>
                </div>
            `;
            // Re-bind suggestion buttons
            messagesEl.querySelectorAll('.chat-suggestion').forEach(btn => {
                btn.addEventListener('click', () => {
                    const question = btn.dataset.q;
                    if (question) {
                        $('chat-input').value = question;
                        handleChatSend();
                    }
                });
            });
        }
    }

    async function handleChatSend() {
        if (chatBusy) return;

        const input = $('chat-input');
        const message = input.value.trim();
        if (!message) return;

        const apiKey = StorageManager.getActiveApiKey();
        if (!apiKey) {
            const p = StorageManager.getProvider();
            const names = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' };
            showToast(`Please configure your ${names[p] || 'AI'} key in Settings to use the chat`, 'error');
            showApiModal();
            return;
        }

        const data = getCurrentData();
        if (!data) {
            showToast('No invoice data available for chat', 'error');
            return;
        }

        // Clear input
        input.value = '';

        // Remove welcome screen if present
        const welcome = $('chat-messages').querySelector('.chat-welcome');
        if (welcome) welcome.remove();

        // Add user message
        appendChatMessage('user', message);

        // Show typing indicator
        const typingEl = showTypingIndicator();

        // Disable send
        chatBusy = true;
        $('btn-chat-send').disabled = true;

        try {
            const response = await InvoiceChat.sendMessage(message, data, apiKey);
            typingEl.remove();
            appendChatMessage('ai', response);
        } catch (err) {
            typingEl.remove();
            appendChatMessage('error', err.message);
        } finally {
            chatBusy = false;
            $('btn-chat-send').disabled = false;
            input.focus();
        }
    }

    function appendChatMessage(type, text) {
        const messagesEl = $('chat-messages');
        const div = document.createElement('div');

        if (type === 'user') {
            div.className = 'chat-msg user';
            div.innerHTML = `
                <div class="chat-msg-avatar">You</div>
                <div class="chat-msg-bubble">${escapeHtml(text)}</div>
            `;
        } else if (type === 'ai') {
            div.className = 'chat-msg ai';
            div.innerHTML = `
                <div class="chat-msg-avatar">AI</div>
                <div class="chat-msg-bubble">${InvoiceChat.formatResponse(text)}</div>
            `;
        } else if (type === 'error') {
            div.className = 'chat-msg error';
            div.innerHTML = `
                <div class="chat-msg-avatar">!</div>
                <div class="chat-msg-bubble">⚠️ ${escapeHtml(text)}</div>
            `;
        }

        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function showTypingIndicator() {
        const messagesEl = $('chat-messages');
        const div = document.createElement('div');
        div.className = 'chat-typing';
        div.innerHTML = `
            <div class="chat-typing-dots"><span></span><span></span><span></span></div>
            <span class="chat-typing-text">AI is thinking...</span>
        `;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return div;
    }

    // ---- Toast Notifications ----
    function showToast(message, type = 'info') {
        const container = $('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ---- Helpers ----
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function statusLabel(status) {
        switch (status) {
            case 'pending': return 'Pending';
            case 'processing': return 'Processing...';
            case 'done': return 'Done ✓';
            case 'error': return 'Error';
            default: return status;
        }
    }

    function formatTimeAgo(isoStr) {
        if (!isoStr) return '';
        const diff = Date.now() - new Date(isoStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(isoStr).toLocaleDateString();
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- Auth & Dashboard Logic ----
    let isLoginMode = true;

    function initSaaSFeatures() {
        $('btn-login-modal').addEventListener('click', () => {
            $('auth-modal').classList.remove('hidden');
            $('auth-error').style.display = 'none';
        });
        
        $('btn-close-auth-modal').addEventListener('click', () => {
            $('auth-modal').classList.add('hidden');
        });

        $('btn-toggle-auth-mode').addEventListener('click', () => {
            isLoginMode = !isLoginMode;
            $('auth-modal-title').textContent = isLoginMode ? 'Sign In' : 'Create Account';
            $('btn-submit-auth').textContent = isLoginMode ? 'Login' : 'Register';
            $('btn-toggle-auth-mode').textContent = isLoginMode ? 'Need an account? Register' : 'Already have an account? Login';
            $('auth-error').style.display = 'none';
        });

        $('btn-submit-auth').addEventListener('click', async () => {
            const email = $('auth-email').value.trim();
            const password = $('auth-password').value.trim();
            const errEl = $('auth-error');
            
            if(!email || !password) {
                errEl.textContent = 'Please fill all fields';
                errEl.style.display = 'block';
                return;
            }

            const emailRegex = /^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/;
            if (!emailRegex.test(email)) {
                errEl.textContent = 'Please enter a valid email address';
                errEl.style.display = 'block';
                return;
            }

            try {
                if (isLoginMode) {
                    const formData = new URLSearchParams();
                    formData.append('username', email); // OAuth2 expects 'username' field
                    formData.append('password', password);

                    const res = await fetch('/api/auth/login', {
                        method: 'POST',
                        body: formData
                    });
                    
                    if (!res.ok) throw new Error('Invalid credentials');
                    
                    const data = await res.json();
                    StorageManager.setToken(data.access_token);
                    
                } else {
                    const res = await fetch('/api/auth/register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: email, password: password })
                    });
                    
                    if (!res.ok) {
                        const errData = await res.json();
                        let errMsg = 'Registration failed';
                        if (Array.isArray(errData.detail)) errMsg = 'Invalid email format or password';
                        else if (errData.detail) errMsg = errData.detail;
                        throw new Error(errMsg);
                    }
                    
                    // Auto login after register
                    const formData = new URLSearchParams();
                    formData.append('username', email);
                    formData.append('password', password);
                    const loginRes = await fetch('/api/auth/login', {
                        method: 'POST',
                        body: formData
                    });
                    const loginData = await loginRes.json();
                    StorageManager.setToken(loginData.access_token);
                }

                $('auth-modal').classList.add('hidden');
                updateAuthState();
                showToast(isLoginMode ? 'Logged in successfully' : 'Account created & logged in', 'success');

            } catch (err) {
                errEl.textContent = err.message;
                errEl.style.display = 'block';
            }
        });

        $('btn-logout').addEventListener('click', () => {
            StorageManager.setToken(null);
            updateAuthState();
            showUpload();
            showToast('Logged out', 'info');
        });

        $('btn-dashboard').addEventListener('click', () => {
            showSection('dashboard');
            if (window.AnalyticsBoard) window.AnalyticsBoard.loadData();
        });

        $('btn-dash-back').addEventListener('click', showUpload);

        updateAuthState();
    }

    function updateAuthState() {
        if (StorageManager.getToken()) {
            $('btn-login-modal').classList.add('hidden');
            $('btn-logout').classList.remove('hidden');
            $('btn-dashboard').classList.remove('hidden');
        } else {
            $('btn-login-modal').classList.remove('hidden');
            $('btn-logout').classList.add('hidden');
            $('btn-dashboard').classList.add('hidden');
        }
    }

    // Initialize SaaS features
    document.addEventListener('DOMContentLoaded', initSaaSFeatures);

})();
