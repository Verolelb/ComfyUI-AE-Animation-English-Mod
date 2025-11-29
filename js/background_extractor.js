class BackgroundExtractor {
    constructor(canvas, backgroundLayer) {
        Object.assign(this, {
            canvas, backgroundLayer,
            width: canvas.width,
            height: canvas.height,
            isDrawing: false,
            tool: 'brush',
            brushSize: 20,
            lastX: 0, lastY: 0
        });
        
        this.selectionCanvas = document.createElement('canvas');
        Object.assign(this.selectionCanvas, { width: this.width, height: this.height });
        this.selectionCtx = this.selectionCanvas.getContext('2d');
        
        this.handlers = {
            mousedown: this.onMouseDown.bind(this),
            mousemove: this.onMouseMove.bind(this),
            mouseup: this.onMouseUp.bind(this),
            mouseleave: this.onMouseUp.bind(this)
        };
        
        this.selectionCtx.fillStyle = 'black';
        this.selectionCtx.fillRect(0, 0, this.width, this.height);
        this.bindEvents();
    }
    
    bindEvents() {
        Object.entries(this.handlers).forEach(([event, handler]) => {
            this.canvas.addEventListener(event, handler);
        });
    }
    
    unbindEvents() {
        Object.entries(this.handlers).forEach(([event, handler]) => {
            this.canvas.removeEventListener(event, handler);
        });
    }
    
    onMouseDown(e) {
        this.isDrawing = true;
        const { x, y } = this.getMousePos(e);
        [this.lastX, this.lastY] = [x, y];
    }
    
    onMouseMove(e) {
        if (!this.isDrawing) return;
        const { x, y } = this.getMousePos(e);
        this.draw(this.lastX, this.lastY, x, y);
        [this.lastX, this.lastY] = [x, y];
    }
    
    onMouseUp() { this.isDrawing = false; }
    
    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const [scaleX, scaleY] = [this.canvas.width / rect.width, this.canvas.height / rect.height];
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }
    
    draw(x1, y1, x2, y2) {
        this.selectionCtx.save();
        
        if (this.tool === 'brush') {
            this.selectionCtx.globalCompositeOperation = 'source-over';
            this.selectionCtx.strokeStyle = 'white';
        } else {
            this.selectionCtx.globalCompositeOperation = 'destination-out';
        }
        
        this.selectionCtx.lineWidth = this.brushSize;
        this.selectionCtx.lineCap = 'round';
        this.selectionCtx.lineJoin = 'round';
        
        this.selectionCtx.beginPath();
        this.selectionCtx.moveTo(x1, y1);
        this.selectionCtx.lineTo(x2, y2);
        this.selectionCtx.stroke();
        
        this.selectionCtx.restore();
    }
    
    clear() {
        this.selectionCtx.fillStyle = 'black';
        this.selectionCtx.fillRect(0, 0, this.width, this.height);
    }
    
    fill() {
        this.selectionCtx.fillStyle = 'white';
        this.selectionCtx.fillRect(0, 0, this.width, this.height);
    }
    
    // Extract foreground and fill background
    async extract() {
        if (!this.backgroundLayer.img) {
            throw new Error('Background image not loaded');
        }
        
        // 1. Create temp canvas for background
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.width;
        tempCanvas.height = this.height;
        const tempCtx = tempCanvas.getContext('2d');
        
        // Draw background image
        const bgImg = this.backgroundLayer.img;
        tempCtx.drawImage(bgImg, 0, 0, this.width, this.height);
        
        // Get image data
        const bgImageData = tempCtx.getImageData(0, 0, this.width, this.height);
        const bgData = bgImageData.data;
        
        // Get selection mask data
        const maskImageData = this.selectionCtx.getImageData(0, 0, this.width, this.height);
        const maskData = maskImageData.data;
        
        // 2. Create foreground image
        const foregroundCanvas = document.createElement('canvas');
        foregroundCanvas.width = this.width;
        foregroundCanvas.height = this.height;
        const fgCtx = foregroundCanvas.getContext('2d');
        const fgImageData = fgCtx.createImageData(this.width, this.height);
        const fgData = fgImageData.data;
        
        // Extract pixels within selection to foreground
        for (let i = 0; i < bgData.length; i += 4) {
            const maskValue = maskData[i]; // R channel as mask
            
            if (maskValue > 128) { // Inside selection
                fgData[i] = bgData[i];         // R
                fgData[i + 1] = bgData[i + 1]; // G
                fgData[i + 2] = bgData[i + 2]; // B
                fgData[i + 3] = 255;           // Alpha = Opaque
            } else {
                fgData[i + 3] = 0; // Alpha = Transparent
            }
        }
        
        fgCtx.putImageData(fgImageData, 0, 0);
        
        // 3. Create filled background
        const filledBgCanvas = document.createElement('canvas');
        filledBgCanvas.width = this.width;
        filledBgCanvas.height = this.height;
        const filledCtx = filledBgCanvas.getContext('2d');
        const filledImageData = filledCtx.createImageData(this.width, this.height);
        const filledData = filledImageData.data;
        
        // Copy original background data
        for (let i = 0; i < bgData.length; i++) {
            filledData[i] = bgData[i];
        }
        
        // 4. Fill the selected area with blur
        const blurRadius = 10; // Blur radius
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const idx = (y * this.width + x) * 4;
                const maskValue = maskData[idx];
                
                if (maskValue > 128) { // Pixels inside selection need filling
                    // Sample from surrounding non-selection pixels and blur
                    let sumR = 0, sumG = 0, sumB = 0, count = 0;
                    
                    // Sample surrounding area
                    for (let dy = -blurRadius; dy <= blurRadius; dy++) {
                        for (let dx = -blurRadius; dx <= blurRadius; dx++) {
                            const nx = x + dx;
                            const ny = y + dy;
                            
                            if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
                                const nidx = (ny * this.width + nx) * 4;
                                const nmask = maskData[nidx];
                                
                                // Sample only from pixels outside selection
                                if (nmask < 128) {
                                    const distance = Math.sqrt(dx * dx + dy * dy);
                                    const weight = Math.max(0, blurRadius - distance);
                                    
                                    sumR += bgData[nidx] * weight;
                                    sumG += bgData[nidx + 1] * weight;
                                    sumB += bgData[nidx + 2] * weight;
                                    count += weight;
                                }
                            }
                        }
                    }
                    
                    if (count > 0) {
                        filledData[idx] = Math.round(sumR / count);
                        filledData[idx + 1] = Math.round(sumG / count);
                        filledData[idx + 2] = Math.round(sumB / count);
                        filledData[idx + 3] = 255;
                    }
                }
            }
        }
        
        filledCtx.putImageData(filledImageData, 0, 0);
        
        // 5. Apply extra Gaussian blur to make filling more natural
        const blurCanvas = await this.applyGaussianBlur(filledBgCanvas, maskImageData, 5);
        
        return {
            foreground: foregroundCanvas.toDataURL('image/png'),
            background: blurCanvas.toDataURL('image/png'),
            mask: this.selectionCanvas.toDataURL('image/png')
        };
    }
    
    // Apply Gaussian blur to selection area
    async applyGaussianBlur(sourceCanvas, maskImageData, iterations) {
        const result = document.createElement('canvas');
        result.width = sourceCanvas.width;
        result.height = sourceCanvas.height;
        const ctx = result.getContext('2d');
        ctx.drawImage(sourceCanvas, 0, 0);
        
        const maskData = maskImageData.data;
        
        for (let iter = 0; iter < iterations; iter++) {
            const imageData = ctx.getImageData(0, 0, this.width, this.height);
            const data = imageData.data;
            const tempData = new Uint8ClampedArray(data);
            
            for (let y = 1; y < this.height - 1; y++) {
                for (let x = 1; x < this.width - 1; x++) {
                    const idx = (y * this.width + x) * 4;
                    const maskValue = maskData[idx];
                    
                    // Blur only inside selection and edges
                    if (maskValue > 64) {
                        // 3x3 Gaussian kernel
                        const kernel = [
                            [1, 2, 1],
                            [2, 4, 2],
                            [1, 2, 1]
                        ];
                        const kernelSum = 16;
                        
                        let sumR = 0, sumG = 0, sumB = 0;
                        
                        for (let ky = -1; ky <= 1; ky++) {
                            for (let kx = -1; kx <= 1; kx++) {
                                const nx = x + kx;
                                const ny = y + ky;
                                const nidx = (ny * this.width + nx) * 4;
                                const weight = kernel[ky + 1][kx + 1];
                                
                                sumR += tempData[nidx] * weight;
                                sumG += tempData[nidx + 1] * weight;
                                sumB += tempData[nidx + 2] * weight;
                            }
                        }
                        
                        data[idx] = sumR / kernelSum;
                        data[idx + 1] = sumG / kernelSum;
                        data[idx + 2] = sumB / kernelSum;
                    }
                }
            }
            
            ctx.putImageData(imageData, 0, 0);
        }
        
        return result;
    }
    
    getSelectionCanvas() { return this.selectionCanvas; }
    setTool(tool) { this.tool = tool; }
    setBrushSize(size) { this.brushSize = Math.max(1, Math.min(100, size)); }
    destroy() { this.unbindEvents(); }
}

// Create Background Extractor UI Panel
function createBackgroundExtractorUI(container, extractor, onExtract, onClose) {
    const panel = document.createElement('div');
    panel.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid #3c3c3c;
        border-radius: 6px;
        padding: 10px;
        z-index: 1000;
        min-width: 200px;
    `;
    
    const title = document.createElement('div');
    title.textContent = '✂️ Background Extractor';
    title.style.cssText = 'color: #fff; font-size: 12px; font-weight: bold; margin-bottom: 8px;';
    panel.appendChild(title);
    
    const info = document.createElement('div');
    info.innerHTML = `
        <div style="color: #888; font-size: 9px; margin-bottom: 8px; line-height: 1.4;">
        Paint over the area to extract.<br>
        Extracted holes will be filled automatically.
        </div>
    `;
    panel.appendChild(info);
    
    // Tools
    const toolRow = document.createElement('div');
    toolRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 6px;';
    
    const brushBtn = document.createElement('button');
    brushBtn.textContent = '🖌️ Brush';
    brushBtn.style.cssText = 'flex: 1; padding: 4px; background: #27ae60; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;';
    brushBtn.onclick = () => {
        extractor.setTool('brush');
        brushBtn.style.background = '#27ae60';
        eraserBtn.style.background = '#555';
    };
    
    const eraserBtn = document.createElement('button');
    eraserBtn.textContent = '🧹 Eraser';
    eraserBtn.style.cssText = 'flex: 1; padding: 4px; background: #555; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;';
    eraserBtn.onclick = () => {
        extractor.setTool('eraser');
        eraserBtn.style.background = '#e74c3c';
        brushBtn.style.background = '#555';
    };
    
    toolRow.appendChild(brushBtn);
    toolRow.appendChild(eraserBtn);
    panel.appendChild(toolRow);
    
    // Brush Size
    const sizeRow = document.createElement('div');
    sizeRow.style.cssText = 'margin-bottom: 6px;';
    
    const sizeLabel = document.createElement('div');
    sizeLabel.textContent = 'Brush Size: 20';
    sizeLabel.style.cssText = 'color: #888; font-size: 10px; margin-bottom: 3px;';
    
    const sizeSlider = document.createElement('input');
    sizeSlider.type = 'range';
    sizeSlider.min = '1';
    sizeSlider.max = '100';
    sizeSlider.value = '20';
    sizeSlider.style.cssText = 'width: 100%;';
    sizeSlider.oninput = () => {
        const size = parseInt(sizeSlider.value);
        extractor.setBrushSize(size);
        sizeLabel.textContent = `Brush Size: ${size}`;
    };
    
    sizeRow.appendChild(sizeLabel);
    sizeRow.appendChild(sizeSlider);
    panel.appendChild(sizeRow);
    
    // Actions
    const actionRow = document.createElement('div');
    actionRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 6px;';
    
    const fillBtn = document.createElement('button');
    fillBtn.textContent = '⬜ Fill All';
    fillBtn.style.cssText = 'flex: 1; padding: 4px; background: #3498db; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;';
    fillBtn.onclick = () => extractor.fill();
    
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '🗑️ Clear';
    clearBtn.style.cssText = 'flex: 1; padding: 4px; background: #e74c3c; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;';
    clearBtn.onclick = () => extractor.clear();
    
    actionRow.appendChild(fillBtn);
    actionRow.appendChild(clearBtn);
    panel.appendChild(actionRow);
    
    // Extract Button
    const extractBtn = document.createElement('button');
    extractBtn.textContent = '✂️ Extract to New Layer';
    extractBtn.style.cssText = 'width: 100%; padding: 6px; background: #e67e22; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: bold; margin-bottom: 4px;';
    extractBtn.onclick = async () => {
        extractBtn.disabled = true;
        extractBtn.textContent = '⏳ Processing...';
        
        try {
            const result = await extractor.extract();
            if (onExtract) {
                onExtract(result);
            }
            alert('✅ Extraction Successful!\nNew foreground layer created.\nBackground filled and blurred.');
            panel.remove();
            if (onClose) onClose();
        } catch (error) {
            alert('❌ Extraction Failed: ' + error.message);
            extractBtn.disabled = false;
            extractBtn.textContent = '✂️ Extract to New Layer';
        }
    };
    panel.appendChild(extractBtn);
    
    // Close Button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕ Cancel';
    closeBtn.style.cssText = 'width: 100%; padding: 4px; background: #95a5a6; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;';
    closeBtn.onclick = () => {
        panel.remove();
        if (onClose) onClose();
    };
    panel.appendChild(closeBtn);
    
    container.appendChild(panel);
    return panel;
}

export { BackgroundExtractor, createBackgroundExtractorUI };