class BezierPathEditor {
    constructor(canvas, layer, fps, duration) {
        Object.assign(this, {
            canvas, layer, fps, duration,
            width: canvas.width,
            height: canvas.height,
            points: [],
            dragPoint: null,
            isDragging: false,
            showControlPoints: true,
            showPath: true,
            pathColor: '#00ff00',
            pointRadius: 6,
            cpRadius: 4
        });
        
        this.handlers = {
            mousedown: this.onMouseDown.bind(this),
            mousemove: this.onMouseMove.bind(this),
            mouseup: this.onMouseUp.bind(this),
            mouseleave: this.onMouseUp.bind(this),
            dblclick: this.onDoubleClick.bind(this)
        };
        
        this.loadPath();
        this.bindEvents();
    }
    
    loadPath() {
        if (this.layer.bezierPath && this.layer.bezierPath.length > 0) {
            this.points = JSON.parse(JSON.stringify(this.layer.bezierPath));
        } else {
            // Default path (2 points)
            this.points = [
                {
                    x: this.width / 4,
                    y: this.height / 2,
                    cp1x: this.width / 4,
                    cp1y: this.height / 2,
                    cp2x: this.width / 4 + 50,
                    cp2y: this.height / 2 - 50
                },
                {
                    x: this.width * 3 / 4,
                    y: this.height / 2,
                    cp1x: this.width * 3 / 4 - 50,
                    cp1y: this.height / 2 + 50,
                    cp2x: this.width * 3 / 4,
                    cp2y: this.height / 2
                }
            ];
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
        const pos = this.getMousePos(e);
        
        // Hit test for points/control points
        for (let i = 0; i < this.points.length; i++) {
            const p = this.points[i];
            
            // Main point
            if (this.hitTest(pos.x, pos.y, p.x, p.y, this.pointRadius)) {
                this.dragPoint = { index: i, type: 'point' };
                this.isDragging = true;
                e.preventDefault();
                return;
            }
            
            // Control point 1
            if (this.hitTest(pos.x, pos.y, p.cp1x, p.cp1y, this.cpRadius)) {
                this.dragPoint = { index: i, type: 'cp1' };
                this.isDragging = true;
                e.preventDefault();
                return;
            }
            
            // Control point 2
            if (this.hitTest(pos.x, pos.y, p.cp2x, p.cp2y, this.cpRadius)) {
                this.dragPoint = { index: i, type: 'cp2' };
                this.isDragging = true;
                e.preventDefault();
                return;
            }
        }
    }
    
    onMouseMove(e) {
        if (!this.isDragging || !this.dragPoint) return;
        
        const pos = this.getMousePos(e);
        const p = this.points[this.dragPoint.index];
        
        if (this.dragPoint.type === 'point') {
            // Move main point, control points follow
            const dx = pos.x - p.x;
            const dy = pos.y - p.y;
            
            p.x = pos.x;
            p.y = pos.y;
            p.cp1x += dx;
            p.cp1y += dy;
            p.cp2x += dx;
            p.cp2y += dy;
        } else if (this.dragPoint.type === 'cp1') {
            p.cp1x = pos.x;
            p.cp1y = pos.y;
        } else if (this.dragPoint.type === 'cp2') {
            p.cp2x = pos.x;
            p.cp2y = pos.y;
        }
        
        this.savePath();
        e.preventDefault();
    }
    
    onMouseUp(e) {
        if (this.isDragging) {
            this.isDragging = false;
            this.dragPoint = null;
        }
    }
    
    onDoubleClick(e) {
        const pos = this.getMousePos(e);
        
        // Add new point
        const newPoint = {
            x: pos.x,
            y: pos.y,
            cp1x: pos.x - 30,
            cp1y: pos.y,
            cp2x: pos.x + 30,
            cp2y: pos.y
        };
        
        this.points.push(newPoint);
        this.savePath();
    }
    
    hitTest(x1, y1, x2, y2, radius) {
        return Math.hypot(x1 - x2, y1 - y2) <= radius;
    }
    
    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const [scaleX, scaleY] = [this.canvas.width / rect.width, this.canvas.height / rect.height];
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }
    
    draw(ctx) {
        if (!this.showPath || this.points.length < 2) return;
        ctx.save();
        
        Object.assign(ctx, { strokeStyle: this.pathColor, lineWidth: 2 });
        ctx.beginPath();
        ctx.moveTo(this.points[0].x, this.points[0].y);
        
        for (let i = 1; i < this.points.length; i++) {
            const [p0, p1] = [this.points[i - 1], this.points[i]];
            ctx.bezierCurveTo(p0.cp2x, p0.cp2y, p1.cp1x, p1.cp1y, p1.x, p1.y);
        }
        ctx.stroke();
        
        if (this.showControlPoints) {
            this.points.forEach((p, i) => {
                Object.assign(ctx, { strokeStyle: '#888', lineWidth: 1 });
                ctx.setLineDash([3, 3]);
                [[p.x, p.y, p.cp1x, p.cp1y], [p.x, p.y, p.cp2x, p.cp2y]].forEach(([x1, y1, x2, y2]) => {
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.stroke();
                });
                ctx.setLineDash([]);
                
                ctx.fillStyle = '#00ff00';
                ctx.beginPath();
                ctx.arc(p.x, p.y, this.pointRadius, 0, Math.PI * 2);
                ctx.fill();
                Object.assign(ctx, { strokeStyle: '#fff', lineWidth: 2 });
                ctx.stroke();
                
                ctx.fillStyle = '#ffaa00';
                [[p.cp1x, p.cp1y], [p.cp2x, p.cp2y]].forEach(([x, y]) => {
                    ctx.beginPath();
                    ctx.arc(x, y, this.cpRadius, 0, Math.PI * 2);
                    ctx.fill();
                });
                
                Object.assign(ctx, { fillStyle: '#fff', font: '10px monospace' });
                ctx.fillText(i.toString(), p.x + 8, p.y - 8);
            });
        }
        ctx.restore();
    }
    
    // Get point on path (t from 0 to 1)
    getPointOnPath(t) {
        if (this.points.length < 2) {
            return this.points[0] || { x: 0, y: 0 };
        }
        
        // Determine segment
        const segmentCount = this.points.length - 1;
        const scaledT = t * segmentCount;
        const segmentIndex = Math.floor(scaledT);
        const segmentT = scaledT - segmentIndex;
        
        if (segmentIndex >= segmentCount) {
            const last = this.points[this.points.length - 1];
            return { x: last.x, y: last.y };
        }
        
        const p0 = this.points[segmentIndex];
        const p1 = this.points[segmentIndex + 1];
        
        // Cubic Bezier Formula
        const t2 = segmentT * segmentT;
        const t3 = t2 * segmentT;
        const mt = 1 - segmentT;
        const mt2 = mt * mt;
        const mt3 = mt2 * mt;
        
        const x = mt3 * p0.x + 
                  3 * mt2 * segmentT * p0.cp2x +
                  3 * mt * t2 * p1.cp1x +
                  t3 * p1.x;
                  
        const y = mt3 * p0.y + 
                  3 * mt2 * segmentT * p0.cp2y +
                  3 * mt * t2 * p1.cp1y +
                  t3 * p1.y;
        
        return { x, y };
    }
    
    // Generate Keyframes
    generateKeyframes(frameCount) {
        if (this.points.length < 2) return [];
        
        const keyframes = [];
        
        for (let i = 0; i <= frameCount; i++) {
            const t = i / frameCount;
            const time = t * this.duration;
            const pos = this.getPointOnPath(t);
            
            // Convert to canvas center coordinates
            const x = pos.x - this.width / 2;
            const y = pos.y - this.height / 2;
            
            keyframes.push({
                time: time,
                x: x,
                y: y
            });
        }
        
        return keyframes;
    }
    
    // Apply path to layer keyframes
    applyToLayer() {
        const keyframes = this.generateKeyframes(Math.floor(this.fps * this.duration));
        
        // Set X and Y keyframes
        this.layer.keyframes.x = keyframes.map(kf => ({ time: kf.time, value: kf.x }));
        this.layer.keyframes.y = keyframes.map(kf => ({ time: kf.time, value: kf.y }));
        
        console.log(`Generated ${keyframes.length} keyframes for bezier path`);
    }
    
    savePath() {
        this.layer.bezierPath = JSON.parse(JSON.stringify(this.points));
    }
    
    addPoint() {
        const last = this.points[this.points.length - 1];
        this.points.push({
            x: last.x + 100, y: last.y,
            cp1x: last.x + 50, cp1y: last.y - 30,
            cp2x: last.x + 150, cp2y: last.y + 30
        });
        this.savePath();
    }
    
    removeLastPoint() {
        if (this.points.length > 2) {
            this.points.pop();
            this.savePath();
        }
    }
    
    clear() { this.points = []; this.savePath(); }
    destroy() { this.unbindEvents(); }
}

const createPathEditorUI = (container, pathEditor, onClose, onApply) => {
    const styles = {
        panel: 'position: absolute; top: 10px; right: 10px; background: rgba(30,30,30,0.95); border: 1px solid #3c3c3c; border-radius: 6px; padding: 10px; z-index: 1000; min-width: 200px;',
        row: 'display: flex; gap: 4px; margin-bottom: 4px;',
        btn: 'flex: 1; padding: 4px; border: none; color: #fff; border-radius: 3px; cursor: pointer; font-size: 10px;'
    };
    
    const panel = document.createElement('div');
    panel.style.cssText = styles.panel;
    
    const info = document.createElement('div');
    info.textContent = `Points: ${pathEditor.points.length}`;
    info.style.cssText = 'color: #888; font-size: 10px; margin-bottom: 6px;';
    
    panel.innerHTML = '<div style="color: #fff; font-size: 12px; font-weight: bold; margin-bottom: 8px;">📈 Path Editor</div>';
    panel.appendChild(info);
    
    const showRow = document.createElement('div');
    showRow.innerHTML = '<input type="checkbox" id="showCP" checked><label for="showCP" style="color: #ddd; font-size: 10px; cursor: pointer;"> Show Controls</label>';
    showRow.style.cssText = 'margin-bottom: 6px;';
    showRow.querySelector('#showCP').onchange = (e) => { pathEditor.showControlPoints = e.target.checked; };
    
    const help = document.createElement('div');
    help.innerHTML = '<div style="color: #888; font-size: 9px; margin-bottom: 6px; line-height: 1.4;">• Drag green: move point<br>• Drag orange: adjust curve<br>• Double-click: add point</div>';
    
    const mkBtn = (text, bg, onClick) => {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = styles.btn + `background: ${bg};`;
        btn.onclick = onClick;
        return btn;
    };
    
    const updateInfo = () => { info.textContent = `Points: ${pathEditor.points.length}`; };
    
    const row1 = document.createElement('div');
    row1.style.cssText = styles.row;
    row1.append(
        mkBtn('➕ Add', '#3498db', () => { pathEditor.addPoint(); updateInfo(); }),
        mkBtn('➖ Remove', '#e74c3c', () => { pathEditor.removeLastPoint(); updateInfo(); })
    );
    
    const applyBtn = mkBtn('✨ Apply to Animation', '#27ae60', () => {
        pathEditor.applyToLayer();
        onApply?.();
        alert('Path applied to X/Y keyframes!');
    });
    applyBtn.style.cssText += ' padding: 6px; font-weight: bold;';
    
    const row3 = document.createElement('div');
    row3.style.cssText = styles.row.replace('4px;', '0;');
    row3.append(
        mkBtn('🗑️ Clear', '#e74c3c', () => confirm('Clear all points?') && (pathEditor.clear(), updateInfo())),
        mkBtn('✓ Done', '#95a5a6', () => { panel.remove(); onClose?.(); })
    );
    
    panel.append(showRow, help, row1, applyBtn, row3);
    container.appendChild(panel);
    return panel;
};

export { BezierPathEditor, createPathEditorUI };