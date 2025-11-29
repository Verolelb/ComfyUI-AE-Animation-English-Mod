class MaskEditor {
    constructor(canvas, layer) {
        Object.assign(this, {
            canvas, layer,
            width: canvas.width,
            height: canvas.height,
            isDrawing: false,
            tool: 'brush',
            brushSize: 20,
            lastX: 0,
            lastY: 0
        });
        
        this.maskCanvas = document.createElement('canvas');
        Object.assign(this.maskCanvas, { width: this.width, height: this.height });
        this.maskCtx = this.maskCanvas.getContext('2d');
        
        this.handlers = {
            mousedown: this.onMouseDown.bind(this),
            mousemove: this.onMouseMove.bind(this),
            mouseup: this.onMouseUp.bind(this),
            mouseleave: this.onMouseUp.bind(this)
        };
        
        this.loadMask();
        this.bindEvents();
    }
    
    loadMask() {
        if (this.layer.maskData) {
            const img = new Image();
            img.onload = () => this.maskCtx.drawImage(img, 0, 0);
            img.src = this.layer.maskData;
        } else {
            this.maskCtx.clearRect(0, 0, this.width, this.height);
        }
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
    
    onMouseUp() {
        if (this.isDrawing) {
            this.isDrawing = false;
            this.saveMask();
        }
    }
    
    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const [scaleX, scaleY] = [this.canvas.width / rect.width, this.canvas.height / rect.height];
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }
    
    draw(x1, y1, x2, y2) {
        const ctx = this.maskCtx;
        ctx.save();
        
        const isBrush = this.tool === 'brush';
        Object.assign(ctx, {
            globalCompositeOperation: isBrush ? 'source-over' : 'destination-out',
            strokeStyle: isBrush ? 'white' : 'rgba(0,0,0,1)',
            lineWidth: this.brushSize,
            lineCap: 'round',
            lineJoin: 'round'
        });
        
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
    }
    
    clear() {
        this.maskCtx.clearRect(0, 0, this.width, this.height);
        this.saveMask();
    }
    
    fill() {
        this.maskCtx.fillStyle = 'white';
        this.maskCtx.fillRect(0, 0, this.width, this.height);
        this.saveMask();
    }
    
    saveMask() {
        this.layer.maskData = this.maskCanvas.toDataURL('image/png');
    }
    
    getMaskCanvas() { return this.maskCanvas; }
    setTool(tool) { this.tool = tool; }
    setBrushSize(size) { this.brushSize = Math.max(1, Math.min(100, size)); }
    destroy() { this.unbindEvents(); }
}

const createMaskEditorUI = (container, maskEditor, onClose) => {
    const styles = {
        panel: 'position: absolute; top: 10px; right: 10px; background: rgba(30,30,30,0.95); border: 1px solid #3c3c3c; border-radius: 6px; padding: 10px; z-index: 1000; min-width: 180px;',
        title: 'color: #fff; font-size: 12px; font-weight: bold; margin-bottom: 8px;',
        row: 'display: flex; gap: 4px; margin-bottom: 6px;',
        btn: 'flex: 1; padding: 4px; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;',
        btnFull: 'width: 100%; padding: 4px; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;'
    };
    
    const panel = document.createElement('div');
    panel.style.cssText = styles.panel;
    panel.innerHTML = '<div style="' + styles.title + '">✏️ Mask Editor</div>';
    
    const mkBtn = (text, bg, onClick) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = styles.btn + `background: ${bg};`;
        btn.onclick = onClick;
        return btn;
    };
    
    const toolRow = document.createElement('div');
    toolRow.style.cssText = styles.row;
    const brushBtn = mkBtn('🖌️ Brush', '#27ae60', () => {
        maskEditor.setTool('brush');
        [brushBtn.style.background, eraserBtn.style.background] = ['#27ae60', '#555'];
    });
    const eraserBtn = mkBtn('🧹 Eraser', '#555', () => {
        maskEditor.setTool('eraser');
        [eraserBtn.style.background, brushBtn.style.background] = ['#e74c3c', '#555'];
    });
    toolRow.append(brushBtn, eraserBtn);
    
    const sizeRow = document.createElement('div');
    sizeRow.style.cssText = 'margin-bottom: 6px;';
    const sizeLabel = document.createElement('div');
    sizeLabel.textContent = 'Size: 20';
    sizeLabel.style.cssText = 'color: #888; font-size: 10px; margin-bottom: 3px;';
    const sizeSlider = document.createElement('input');
    Object.assign(sizeSlider, { type: 'range', min: '1', max: '100', value: '20' });
    sizeSlider.style.width = '100%';
    sizeSlider.oninput = () => {
        const size = parseInt(sizeSlider.value);
        maskEditor.setBrushSize(size);
        sizeLabel.textContent = `Size: ${size}`;
    };
    sizeRow.append(sizeLabel, sizeSlider);
    
    const actionRow = document.createElement('div');
    actionRow.style.cssText = styles.row;
    actionRow.append(
        mkBtn('⬜ Fill', '#3498db', () => maskEditor.fill()),
        mkBtn('🗑️ Clear', '#e74c3c', () => confirm('Clear mask?') && maskEditor.clear())
    );
    
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✓ Done';
    closeBtn.style.cssText = styles.btnFull + 'background: #27ae60;';
    closeBtn.onclick = () => {
        panel.remove();
        onClose?.();
    };
    
    panel.append(toolRow, sizeRow, actionRow, closeBtn);
    container.appendChild(panel);
    return panel;
};

export { MaskEditor, createMaskEditorUI };