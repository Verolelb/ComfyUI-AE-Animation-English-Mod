import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const VIEW_REGISTRY = new Map();
// Removed "scale" (legacy), added "scale_x", "scale_y"
const KF_PROPS = ["x", "y", "scale_x", "scale_y", "rotation", "opacity", "mask_size", "flip_h", "flip_v"];

class AeTimelineView {
    constructor(node) {
        this.node = node;
        this.widgets = this.#setupWidgets();
        this.state = this.#createState();
        if (this.widgets.width) {
            this.state.width = this.#coerceInt(this.widgets.width.value, this.state.width);
        }
        if (this.widgets.height) {
            this.state.height = this.#coerceInt(this.widgets.height.value, this.state.height);
        }
        this._lastServerAnimation = null;
        this.ui = this.#buildUI();
        this.#bindEvents();
        this.#loadFromWidget();
    }

    mount() {
        this.node.addDOMWidget("ae_timeline", "editor", this.ui.root);
    }

    dispose() {
        VIEW_REGISTRY.delete(this.node.id);
        this.#stopPlayback();
    }

    load(animation) {
        if (!animation) return;
        const project = animation.project || {};
        Object.assign(this.state, {
            duration: project.duration || 5,
            fps: project.fps || 30,
            totalFrames: project.total_frames || Math.floor((project.fps || 30) * (project.duration || 5))
        });
        this.#setResolution(project.width || this.state.width, project.height || this.state.height);
        this.#updateInfo();
        this.ui.frameCount.value = this.state.totalFrames;

        this.state.layers = (animation.layers || []).map((layer) => this.#normalizeLayer(layer));

        this.#loadImages().then(() => {
            this.#syncLayerSelect();
            this.#applyTime(this.state.currentTime);
            // Save with image cache on initial load
            this.#persist(true);
            this.#updateInfo();
        });
    }

    #loadFromWidget() {
        if (!this.widgets.keyframes) return;
        try {
            const layers = JSON.parse(this.widgets.keyframes.value || "[]");
            if (!Array.isArray(layers)) return;
            this.load({
                project: {
                    duration: this.state.duration,
                    fps: this.state.fps,
                    total_frames: this.state.totalFrames,
                },
                layers,
            });
        } catch (err) {
            console.warn("[AE Animation] Failed to parse widget state", err);
        }
    }

    #setupWidgets() {
        // Hide layers_keyframes widget
        const keyWidget = this.node.widgets?.find((w) => w.name === "layers_keyframes");
        if (keyWidget) {
            keyWidget.type = "converted-widget";
            keyWidget.computeSize = () => [0, -4];
        }
        
        // Hide unique_id widget and set node ID
        const uniqueIdWidget = this.node.widgets?.find((w) => w.name === "unique_id");
        if (uniqueIdWidget) {
            uniqueIdWidget.type = "converted-widget";
            uniqueIdWidget.computeSize = () => [0, -4];
            // Set node ID when it's available
            const setNodeId = () => {
                if (this.node.id && this.node.id !== -1) {
                    uniqueIdWidget.value = String(this.node.id);
                } else {
                    setTimeout(setNodeId, 50);
                }
            };
            setNodeId();
        }
        const widthWidget = this.node.widgets?.find((w) => w.name === "width");
        if (widthWidget) {
            widthWidget.type = "converted-widget";
            widthWidget.computeSize = () => [0, -4];
        }
        const heightWidget = this.node.widgets?.find((w) => w.name === "height");
        if (heightWidget) {
            heightWidget.type = "converted-widget";
            heightWidget.computeSize = () => [0, -4];
        }
        const fpsWidget = this.node.widgets?.find((w) => w.name === "fps");
        if (fpsWidget) {
            fpsWidget.type = "converted-widget";
            fpsWidget.computeSize = () => [0, -4];
        }
        
        const previewWidget = this.node.widgets?.find((w) => w.name === "ui_preview_only");
        if (previewWidget) {
            previewWidget.type = "converted-widget";
            previewWidget.computeSize = () => [0, -4];
            previewWidget.value = !!previewWidget.value;
        }

        const totalFramesWidget = this.node.widgets?.find((w) => w.name === "total_frames");
        if (totalFramesWidget) {
            totalFramesWidget.type = "converted-widget";
            totalFramesWidget.computeSize = () => [0, -4];
        }

        const widgets = {
            keyframes: keyWidget,
            totalFrames: totalFramesWidget,
            uniqueId: uniqueIdWidget,
            width: widthWidget,
            height: heightWidget,
            fps: fpsWidget,
            previewFlag: previewWidget
        };
        
        return widgets;
    }

    #createState() {
        return {
            layers: [],
            selectedId: null,
            duration: 5,
            fps: 16,
            totalFrames: 81,
            currentTime: 0,
            width: 1280,
            height: 720,
            draggingLayer: false,
            dragOffset: { x: 0, y: 0 },
            playing: false,
            rafId: null,
            mask: { enabled: false, drawing: false, erase: false, brush: 20 },
            path: { enabled: false, data: null, dragging: null },
            extract: { enabled: false, drawing: false, brush: 30, blurType: 'gaussian' },
            dragKeyframe: null,
            jitter: { amount: 2 },
            forceServerReload: false
        };
    }

    #buildUI() {
        const root = document.createElement("div");
        root.style.cssText = "background:#1a1a1a;border:1px solid #3c3c3c;border-radius:6px;padding:8px;margin-top:6px;color:#ddd";

        const infoRow = document.createElement("div");
        infoRow.style.cssText = "display:flex;gap:8px;align-items:center;background:#252525;padding:4px;border-radius:4px;font-family:monospace;font-size:10px";
        const infoText = document.createElement("span");
        infoText.textContent = "Loading project info...";
        const resGroup = document.createElement("div");
        resGroup.style.cssText = "display:flex;align-items:center;gap:4px;flex-wrap:wrap";
        const resLabel = document.createElement("span");
        resLabel.textContent = "Res:";
        resLabel.style.cssText = "color:#888;font-size:10px";
        const resWidth = document.createElement("input");
        Object.assign(resWidth, { type: "number", min: 64, max: 8192, step: 1, value: this.state.width });
        resWidth.style.cssText = "width:70px;background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;padding:2px 4px";
        const resHeight = document.createElement("input");
        Object.assign(resHeight, { type: "number", min: 64, max: 8192, step: 1, value: this.state.height });
        resHeight.style.cssText = resWidth.style.cssText;
        const fpsLabel = document.createElement("span");
        fpsLabel.textContent = "FPS:";
        fpsLabel.style.cssText = "color:#888;font-size:10px";
        const fpsInput = document.createElement("input");
        Object.assign(fpsInput, { type: "number", min: 1, max: 120, step: 1, value: this.state.fps });
        fpsInput.style.cssText = resWidth.style.cssText;
        const frameLabel = document.createElement("span");
        frameLabel.textContent = "Frames:";
        frameLabel.style.cssText = "color:#888;font-size:10px";
        const resApply = document.createElement("button");
        resApply.textContent = "Apply";
        resApply.style.cssText = "background:#5c8ec8;border:1px solid #6fa0dc;color:#fff;border-radius:3px;padding:2px 8px;font-size:10px;cursor:pointer";
        const frameInput = document.createElement("input");
        Object.assign(frameInput, { type: "number", min: 1, value: 81, step: 1 });
        frameInput.style.cssText = "width:70px;background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;padding:2px 4px";
        resGroup.append(
            resLabel,
            resWidth,
            document.createTextNode("×"),
            resHeight,
            fpsLabel,
            fpsInput,
            frameLabel,
            frameInput,
            resApply
        );
        infoRow.append(infoText, resGroup);
        root.append(infoRow);

        const canvas = document.createElement("canvas");
        const previewW = Math.min(this.state.width, 1920);
        const previewH = Math.min(this.state.height, 1080);
        canvas.width = previewW;
        canvas.height = previewH;
        canvas.style.aspectRatio = `${previewW}/${previewH}`;
        canvas.style.cssText = "width:100%;background:#000;border-radius:4px;margin:8px 0;cursor:crosshair";
        root.append(canvas);

        const layerRow = document.createElement("div");
        layerRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center";
        const layerSelect = document.createElement("select");
        layerSelect.style.cssText = "flex:0 0 140px;background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;padding:3px;font-size:10px";
        
        // Layer order controls
        const mkOrderBtn = (text, title) => {
            const btn = document.createElement("button");
            btn.textContent = text;
            btn.title = title;
            btn.style.cssText = "background:#3c3c3c;border:1px solid #555;color:#fff;border-radius:3px;padding:2px 6px;font-size:10px;cursor:pointer;min-width:24px";
            return btn;
        };
        const layerUpBtn = mkOrderBtn("↑", "Move Up");
        const layerDownBtn = mkOrderBtn("↓", "Move Down");
        const layerTopBtn = mkOrderBtn("⇈", "Move to Top");
        const layerBottomBtn = mkOrderBtn("⇊", "Move to Bottom");
        const addImageBtn = document.createElement("button");
        addImageBtn.textContent = "＋Image";
        addImageBtn.title = "Add local image as foreground";
        addImageBtn.style.cssText = "background:#4a9c4a;border:1px solid #5fb65f;color:#fff;border-radius:3px;padding:2px 10px;font-size:10px;cursor:pointer";
        const addBgBtn = document.createElement("button");
        addBgBtn.textContent = "＋Background";
        addBgBtn.title = "Set background image";
        addBgBtn.style.cssText = "background:#3a7bc8;border:1px solid #4c8fdc;color:#fff;border-radius:3px;padding:2px 10px;font-size:10px;cursor:pointer";
        const clearCacheBtn = document.createElement("button");
        clearCacheBtn.textContent = "🧹 Clear Cache";
        clearCacheBtn.title = "Clear unused image cache";
        clearCacheBtn.style.cssText = "background:#555;border:1px solid #666;color:#fff;border-radius:3px;padding:2px 10px;font-size:10px;cursor:pointer";
        
        const bgSelect = document.createElement("select");
        bgSelect.style.cssText = "flex:0 0 120px;background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;padding:3px;font-size:10px;display:none";
        bgSelect.innerHTML = '<option value="fit">Fit</option><option value="fill">Fill</option><option value="stretch">Stretch</option>';
        layerRow.append(layerSelect, layerUpBtn, layerDownBtn, layerTopBtn, layerBottomBtn, addImageBtn, addBgBtn, clearCacheBtn, bgSelect);

        const addImageInput = document.createElement("input");
        addImageInput.type = "file";
        addImageInput.accept = "image/*";
        addImageInput.multiple = true;
        addImageInput.style.display = "none";
        const addBgInput = document.createElement("input");
        addBgInput.type = "file";
        addBgInput.accept = "image/*";
        addBgInput.style.display = "none";
        
        // Background transform controls
        const bgRow = document.createElement("div");
        bgRow.style.cssText = "display:none;gap:6px;flex-wrap:wrap;margin-bottom:6px";
        const makeBgInput = (label, prop, step, opts = {}) => {
            const wrap = document.createElement("label");
            wrap.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;color:#888";
            wrap.textContent = label + ":";
            const input = document.createElement("input");
            input.type = "number";
            input.step = step;
            if (opts.min !== undefined) input.min = opts.min;
            if (opts.max !== undefined) input.max = opts.max;
            input.dataset.prop = prop;
            input.style.cssText = "width:60px;background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;padding:2px 4px";
            wrap.append(input);
            bgRow.append(wrap);
            return input;
        };
        const bgInputs = {
            x: makeBgInput("X", "x", 1),
            y: makeBgInput("Y", "y", 1),
            // Replaced Scale with Scale X/Y for background
            scale_x: makeBgInput("Scale X", "scale_x", 0.01, { min: 0.01 }),
            scale_y: makeBgInput("Scale Y", "scale_y", 0.01, { min: 0.01 }),
            rotation: makeBgInput("Rot", "rotation", 1),
            flip_h: makeBgInput("Flip H", "flip_h", 1, { min: 0, max: 1 }),
            flip_v: makeBgInput("Flip V", "flip_v", 1, { min: 0, max: 1 })
        };
        root.append(layerRow, bgRow, addImageInput, addBgInput);

        const fgRow = document.createElement("div");
        fgRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px";
        
        const makeCheckboxInput = (label, prop) => {
             const wrap = document.createElement("label");
            wrap.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;color:#888;cursor:pointer";
            
            const input = document.createElement("input");
            input.type = "checkbox";
            input.dataset.prop = prop;
            input.style.cssText = "cursor:pointer";
            
            const span = document.createElement("span");
            span.textContent = label;
            
            wrap.append(input, span);
            fgRow.append(wrap);
            return input;
        };

        const makeInput = (label, prop, step, { min, max } = {}) => {
            const wrap = document.createElement("label");
            wrap.style.cssText = "display:flex;align-items:center;gap:4px;font-size:10px;color:#888";
            wrap.textContent = label + ":";
            const input = document.createElement("input");
            input.type = "number";
            input.step = step;
            if (min !== undefined) input.min = min;
            if (max !== undefined) input.max = max;
            input.dataset.prop = prop;
            input.style.cssText = "width:60px;background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;padding:2px 4px";
            wrap.append(input);
            fgRow.append(wrap);
            return input;
        };

        const inputs = {
            x: makeInput("X", "x", 1),
            y: makeInput("Y", "y", 1),
            // Replaced single Scale with Scale X and Scale Y
            scale_x: makeInput("Scale X", "scale_x", 0.01, { min: 0.01 }),
            scale_y: makeInput("Scale Y", "scale_y", 0.01, { min: 0.01 }),
            rotation: makeInput("Rot", "rotation", 1),
            opacity: makeInput("Opacity", "opacity", 0.01, { min: 0, max: 1 }),
            mask_size: makeInput("Mask", "mask_size", 0.01, { min: 0.01 }),
            flip_h: makeCheckboxInput("Flip H", "flip_h"),
            flip_v: makeCheckboxInput("Flip V", "flip_v")
        };
        root.append(fgRow);

        const timelineCanvas = document.createElement("canvas");
        Object.assign(timelineCanvas, { width: 1000, height: 80 });
        timelineCanvas.style.cssText = "width:100%;background:#252525;border-radius:4px;cursor:pointer;margin-bottom:6px";
        root.append(timelineCanvas);

        const ctrlRow = document.createElement("div");
        ctrlRow.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;align-items:center";
        const timeInput = document.createElement("input");
        Object.assign(timeInput, { type: "number", step: "0.01", value: "0.00", min: 0 });
        timeInput.style.cssText = "width:80px;background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;padding:2px 4px";
        const mkBtn = (txt, color) => {
            const btn = document.createElement("button");
            btn.textContent = txt;
            btn.style.cssText = `background:${color};border:none;color:#fff;padding:3px 8px;border-radius:3px;font-size:10px;cursor:pointer`;
            return btn;
        };
        const goBtn = mkBtn("→", "#3a7bc8");
        const addBtn = mkBtn("◆", "#c8553a");
        const delBtn = mkBtn("✕", "#c83a3a");
        const clrBtn = mkBtn("ALL", "#c83a3a");
        const maskBtn = mkBtn("🖌 Mask", "#3ac88e");
        const maskBrushLabel = document.createElement("span");
        maskBrushLabel.textContent = "Brush:";
        maskBrushLabel.style.cssText = "color:#888;font-size:10px;display:none;margin-left:6px";
        const maskBrushInput = document.createElement("input");
        maskBrushInput.type = "range";
        maskBrushInput.min = "5";
        maskBrushInput.max = "100";
        maskBrushInput.value = "20";
        maskBrushInput.style.cssText = "width:80px;display:none";
        const maskBrushValue = document.createElement("span");
        maskBrushValue.textContent = "20";
        maskBrushValue.style.cssText = "color:#888;font-size:10px;display:none;width:25px;text-align:right";
        const maskApplyBtn = mkBtn("✓ Apply Mask", "#2d9d6e");
        maskApplyBtn.style.display = "none";
        const maskJitterBtn = mkBtn("~ Jitter", "#8e5cc8");
        maskJitterBtn.style.display = "none";
        const maskJitterInput = document.createElement("input");
        maskJitterInput.type = "range";
        maskJitterInput.min = "1";
        maskJitterInput.max = "10";
        maskJitterInput.value = String(this.state.jitter.amount);
        maskJitterInput.style.cssText = "width:60px;display:none";
        const maskJitterValue = document.createElement("span");
        maskJitterValue.textContent = `${this.state.jitter.amount}px`;
        maskJitterValue.style.cssText = "color:#888;font-size:10px;display:none;width:32px;text-align:right";
        const pathBtn = mkBtn("📍 Path", "#c88e3a");
        const pathAddBtn = mkBtn("+ Point", "#8a5020");
        pathAddBtn.style.display = "none";
        const pathApplyBtn = mkBtn("✓ Apply", "#a67020");
        pathApplyBtn.style.display = "none";
        const extractBtn = mkBtn("✂ Extract", "#c83aa0");
        const extractBrushLabel = document.createElement("span");
        extractBrushLabel.textContent = "Brush:";
        extractBrushLabel.style.cssText = "color:#888;font-size:10px;display:none;margin-left:6px";
        const extractBrushInput = document.createElement("input");
        extractBrushInput.type = "range";
        extractBrushInput.min = "10";
        extractBrushInput.max = "100";
        extractBrushInput.value = "30";
        extractBrushInput.style.cssText = "width:80px;display:none";
        const extractBrushValue = document.createElement("span");
        extractBrushValue.textContent = "30";
        extractBrushValue.style.cssText = "color:#888;font-size:10px;display:none;width:25px;text-align:right";
        const extractBlurLabel = document.createElement("span");
        extractBlurLabel.textContent = "Blur:";
        extractBlurLabel.style.cssText = "color:#888;font-size:10px;display:none;margin-left:6px";
        const extractBlurSelect = document.createElement("select");
        extractBlurSelect.innerHTML = '<option value="gaussian">Gaussian</option><option value="radial">Radial</option>';
        extractBlurSelect.style.cssText = "background:#2d2d2d;border:1px solid #3c3c3c;color:#fff;border-radius:3px;font-size:10px;display:none";
        const extractApplyBtn = mkBtn("✓ Extract Region", "#a02080");
        extractApplyBtn.style.display = "none";
        const playBtn = mkBtn("▶", "#3a7bc8");
        const stopBtn = mkBtn("■", "#c83a3a");
        const refreshBtn = mkBtn("🔄", "#5c8ec8");
        refreshBtn.title = "Refresh Preview (Load from cache)";
        const timeLabel = document.createElement("span");
        timeLabel.style.cssText = "margin-left:auto;color:#888;font-size:10px";
        timeLabel.textContent = "0.00s";
        const runBtn = mkBtn("⚡ Run", "#c8a33a");
        ctrlRow.append(timeInput, goBtn, addBtn, delBtn, clrBtn, maskBtn, maskBrushLabel, maskBrushInput, maskBrushValue, maskApplyBtn, maskJitterBtn, maskJitterInput, maskJitterValue, pathBtn, pathAddBtn, pathApplyBtn, extractBtn, extractBrushLabel, extractBrushInput, extractBrushValue, extractBlurLabel, extractBlurSelect, extractApplyBtn, playBtn, stopBtn, refreshBtn, runBtn, timeLabel);
        root.append(ctrlRow);

        const maskCanvas = document.createElement("canvas");
        const maskCtx = maskCanvas.getContext("2d");
        
        const extractCanvas = document.createElement("canvas");
        const extractCtx = extractCanvas.getContext("2d");

        return {
            root,
            info: infoText,
            frameCount: frameInput,
            canvas,
            ctx: canvas.getContext("2d"),
            layerSelect,
            layerUpBtn,
            layerDownBtn,
            layerTopBtn,
            layerBottomBtn,
            addImageBtn,
            addBgBtn,
            clearCacheBtn,
            bgSelect,
            bgRow,
            bgInputs,
            fgRow,
            inputs,
            timelineCanvas,
            timelineCtx: timelineCanvas.getContext("2d"),
            timeInput,
            goBtn,
            addBtn,
            delBtn,
            clrBtn,
            maskBtn,
            maskBrushLabel,
            maskBrushInput,
            maskBrushValue,
            maskApplyBtn,
            maskJitterBtn,
            maskJitterInput,
            maskJitterValue,
            pathBtn,
            pathAddBtn,
            pathApplyBtn,
            extractBtn,
            extractBrushLabel,
            extractBrushInput,
            extractBrushValue,
            extractApplyBtn,
            extractBlurLabel,
            extractBlurSelect,
            playBtn,
            stopBtn,
            refreshBtn,
            runBtn,
            timeLabel,
            maskCanvas,
            maskCtx,
            extractCanvas,
            extractCtx,
            addImageInput,
            addBgInput,
            widthInput: resWidth,
            heightInput: resHeight,
            fpsInput,
            applyResolutionBtn: resApply
        };
    }

    #bindEvents() {
        const ui = this.ui;
        ui.layerSelect.addEventListener("change", () => {
            this.state.selectedId = ui.layerSelect.value;
            this.#applyTime(this.state.currentTime);
        });
        ui.layerUpBtn.addEventListener("click", () => this.#moveLayer(-1));
        ui.layerDownBtn.addEventListener("click", () => this.#moveLayer(1));
        ui.layerTopBtn.addEventListener("click", () => this.#moveLayerToTop());
        ui.layerBottomBtn.addEventListener("click", () => this.#moveLayerToBottom());
        ui.addImageBtn.addEventListener("click", () => ui.addImageInput.click());
        ui.addImageInput.addEventListener("change", (event) => {
            this.#handleImageFiles(event.target.files);
        });
        ui.addBgBtn.addEventListener("click", () => ui.addBgInput.click());
        ui.addBgInput.addEventListener("change", (event) => {
            if (event.target.files?.[0]) {
                this.#handleBackgroundFile(event.target.files[0]);
            }
        });
        ui.clearCacheBtn.addEventListener("click", () => this.#clearUnusedCache());
        ui.bgSelect.addEventListener("change", () => {
            const layer = this.#currentLayer();
            if (layer && layer.type === "background") {
                layer.bg_mode = ui.bgSelect.value;
                this.#render();
                this.#persist();
            }
        });
        const applyProjectSettings = () => {
            const width = this.#coerceInt(ui.widthInput.value, this.state.width, { min: 64, max: 8192 });
            const height = this.#coerceInt(ui.heightInput.value, this.state.height, { min: 64, max: 8192 });
            const fps = this.#coerceInt(ui.fpsInput.value, this.state.fps, { min: 1, max: 120 });
            const frames = this.#coerceInt(ui.frameCount.value, this.state.totalFrames, { min: 1, max: 9999 });
            this.#setResolution(width, height, { userInitiated: true });
            this.#setTimelineMetrics(fps, frames, { userInitiated: true });
        };
        ui.applyResolutionBtn.addEventListener("click", applyProjectSettings);
        [ui.widthInput, ui.heightInput, ui.fpsInput, ui.frameCount].forEach((input) => {
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    applyProjectSettings();
                }
            });
        });

        // Handle inputs
        Object.entries(ui.inputs).forEach(([prop, input]) => {
            input.addEventListener("change", () => { 
                const layer = this.#currentLayer();
                if (!layer || layer.type === "background") return;
                
                let value;
                if (input.type === "checkbox") {
                    value = input.checked ? 1 : 0;
                } else {
                    value = parseFloat(input.value);
                }
                
                if (Number.isNaN(value)) return;
                layer[prop] = value;
                this.#render();
                this.#persist();
            });
             if (input.type !== "checkbox") {
                input.addEventListener("input", () => {
                     const layer = this.#currentLayer();
                    if (!layer || layer.type === "background") return;
                    const value = parseFloat(input.value);
                    if (Number.isNaN(value)) return;
                    layer[prop] = value;
                    this.#render();
                    this.#persist();
                });
             }
        });

        ui.goBtn.addEventListener("click", () => {
            const t = parseFloat(ui.timeInput.value);
            if (Number.isNaN(t)) return;
            this.#applyTime(Math.max(0, Math.min(this.state.duration, t)));
        });
        ui.addBtn.addEventListener("click", () => this.#addKeyframe());
        ui.delBtn.addEventListener("click", () => this.#deleteKeyframe());
        ui.clrBtn.addEventListener("click", () => this.#clearKeyframes());
        ui.maskBtn.addEventListener("click", () => this.#toggleMaskMode());
        ui.maskBrushInput.addEventListener("input", () => {
            this.state.mask.brush = parseInt(ui.maskBrushInput.value, 10);
            ui.maskBrushValue.textContent = ui.maskBrushInput.value;
        });
        ui.maskApplyBtn.addEventListener("click", () => this.#applyMask());
        ui.pathBtn.addEventListener("click", () => this.#togglePathMode());
        ui.pathAddBtn.addEventListener("click", () => this.#addPathPoint());
        ui.pathApplyBtn.addEventListener("click", () => this.#applyPathToKeyframes());
        ui.extractBtn.addEventListener("click", () => this.#toggleExtractMode());
        ui.extractBrushInput.addEventListener("input", () => {
            this.state.extract.brush = parseInt(ui.extractBrushInput.value, 10);
            ui.extractBrushValue.textContent = ui.extractBrushInput.value;
        });
        ui.extractBlurSelect.addEventListener("change", () => {
            this.state.extract.blurType = ui.extractBlurSelect.value;
        });
        ui.extractApplyBtn.addEventListener("click", () => this.#applyExtraction());
        ui.playBtn.addEventListener("click", () => this.#startPlayback());
        ui.stopBtn.addEventListener("click", () => this.#stopPlayback());
        ui.refreshBtn.addEventListener("click", () => this.#refreshFromCache());
        ui.runBtn.addEventListener("click", () => this.#executeNode());
        ui.maskJitterBtn.addEventListener("click", () => this.#applyMaskJitter());
        ui.maskJitterInput.addEventListener("input", () => {
            this.state.jitter.amount = this.#coerceInt(ui.maskJitterInput.value, this.state.jitter.amount, { min: 1, max: 10 });
            ui.maskJitterValue.textContent = `${this.state.jitter.amount}px`;
        });
        
        // Background transform inputs
        Object.entries(ui.bgInputs).forEach(([prop, input]) => {
            input.addEventListener("input", () => {
                const layer = this.#currentLayer();
                if (!layer || layer.type !== "background") return;
                const value = parseFloat(input.value);
                if (Number.isNaN(value)) return;
                layer[prop] = value;
                this.#render();
                this.#persist();
            });
        });

        this.#bindCanvas();
        this.#bindTimeline();
    }

    #bindCanvas() {
        const canvas = this.ui.canvas;
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        canvas.addEventListener("mousedown", (e) => this.#onCanvasDown(e));
        canvas.addEventListener("mousemove", (e) => this.#onCanvasMove(e));
        document.addEventListener("mouseup", () => this.#onCanvasUp());
        canvas.addEventListener("wheel", (e) => this.#onCanvasWheel(e));
    }

    #bindTimeline() {
        const tl = this.ui.timelineCanvas;
        tl.addEventListener("mousedown", (e) => this.#onTimelineDown(e));
        tl.addEventListener("mousemove", (e) => this.#onTimelineMove(e));
        tl.addEventListener("mouseup", () => this.#onTimelineUp());
        tl.addEventListener("mouseleave", () => this.#onTimelineUp());
    }

    async #loadImages() {
        const promises = this.state.layers.map((layer, idx) => {
            if (!layer.image_data) {
                console.warn(`[AE] Layer ${layer.name} missing image_data`);
                return Promise.resolve();
            }
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    layer.img = img;
                    resolve();
                };
                img.onerror = (err) => {
                    console.error(`[AE] Load failed: ${layer.name}`, err);
                    resolve();
                };
                img.src = layer.image_data;
            });
        });
        await Promise.all(promises);
    }

    #currentLayer() {
        return this.state.layers.find((l) => l.id === this.state.selectedId) || null;
    }

    #applyTime(time) {
        this.state.currentTime = Math.max(0, Math.min(this.state.duration, time));
        this.state.layers.forEach((layer) => {
            // Apply keyframe interpolation to all layers including background
            KF_PROPS.forEach((prop) => {
                const frames = (layer.keyframes[prop] || []).slice().sort((a, b) => a.time - b.time);
                if (!frames.length) return;
                if (this.state.currentTime <= frames[0].time) {
                    layer[prop] = frames[0].value;
                    return;
                }
                if (this.state.currentTime >= frames[frames.length - 1].time) {
                    layer[prop] = frames[frames.length - 1].value;
                    return;
                }
                for (let i = 0; i < frames.length - 1; i += 1) {
                    const a = frames[i];
                    const b = frames[i + 1];
                    if (a.time <= this.state.currentTime && this.state.currentTime <= b.time) {
                        const t = (this.state.currentTime - a.time) / (b.time - a.time || 1);
                        layer[prop] = a.value + (b.value - a.value) * t;
                        break;
                    }
                }
            });
        });
        this.#render();
        this.#updateForm();
        this.#drawTimeline();
    }

    #render() {
        if (this._renderPending) return;
        this._renderPending = true;
        requestAnimationFrame(() => {
            this._renderPending = false;
            const ctx = this.ui.ctx;
            const canvas = this.ui.canvas;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            this.state.layers.forEach((layer) => {
                if (!layer.img && layer.image_data) {
                    this.#ensureLayerImage(layer);
                    return;
                }
                if (!layer.img) return;
                
                ctx.save();
                if (layer.type === "background") {
                    this.#drawBackground(layer);
                } else {
                    ctx.globalAlpha = layer.opacity;
                    ctx.translate(canvas.width / 2 + layer.x, canvas.height / 2 + layer.y);
                    ctx.rotate((layer.rotation * Math.PI) / 180);
                    
                    // Independent Scaling + Flip
                    const sx = (layer.scale_x || 1) * (layer.flip_h > 0.5 ? -1 : 1);
                    const sy = (layer.scale_y || 1) * (layer.flip_v > 0.5 ? -1 : 1);
                    ctx.scale(sx, sy);
                    
                    ctx.drawImage(layer.img, -layer.img.width / 2, -layer.img.height / 2);
                    
                    if (layer.mask_size !== 1) {
                        ctx.strokeStyle = "#00ff00";
                        // Adjust linewidth to be visible despite scale
                        ctx.lineWidth = 2 / Math.max(Math.abs(sx), Math.abs(sy));
                        const maskW = layer.img.width * layer.mask_size;
                        const maskH = layer.img.height * layer.mask_size;
                        ctx.strokeRect(-maskW / 2, -maskH / 2, maskW, maskH);
                    }
                }
                ctx.restore();
            });
            if (this.state.path.enabled && this.state.path.data) {
                this.#drawBezier(this.state.path.data);
            }
            if (this.state.mask.enabled && this.ui.maskCanvas.width) {
                const layer = this.#currentLayer();
                if (layer && layer.img) {
                    ctx.save();
                    ctx.globalAlpha = 0.5;
                    ctx.translate(canvas.width / 2 + layer.x, canvas.height / 2 + layer.y);
                    ctx.rotate((layer.rotation * Math.PI) / 180);
                    
                    const sx = (layer.scale_x || 1) * (layer.flip_h > 0.5 ? -1 : 1);
                    const sy = (layer.scale_y || 1) * (layer.flip_v > 0.5 ? -1 : 1);
                    ctx.scale(sx, sy);
                    
                    ctx.drawImage(this.ui.maskCanvas, -layer.img.width / 2, -layer.img.height / 2);
                    ctx.restore();
                }
            }
            if (this.state.extract.enabled && this.ui.extractCanvas.width) {
                const bgLayer = this.state.layers.find(l => l.type === "background");
                if (bgLayer && bgLayer.img) {
                    ctx.save();
                    ctx.globalAlpha = 0.5;
                    const canvasW = canvas.width;
                    const canvasH = canvas.height;
                    const bgW = bgLayer.img.width;
                    const bgH = bgLayer.img.height;
                    const bgMode = bgLayer.bg_mode || "fit";
                    const bgScaleX = bgLayer.scale_x || 1;
                    const bgScaleY = bgLayer.scale_y || 1;
                    const bgX = bgLayer.x || 0;
                    const bgY = bgLayer.y || 0;
                    
                    let baseScale = 1;
                    if (bgMode === "fit") {
                        baseScale = Math.min(canvasW / bgW, canvasH / bgH);
                    } else if (bgMode === "fill") {
                        baseScale = Math.max(canvasW / bgW, canvasH / bgH);
                    }
                    
                    ctx.translate(canvasW / 2 + bgX, canvasH / 2 + bgY);
                    ctx.scale(baseScale * bgScaleX, baseScale * bgScaleY);
                    ctx.drawImage(this.ui.extractCanvas, -bgW / 2, -bgH / 2);
                    ctx.restore();
                }
            }
            this.ui.timeLabel.textContent = `${this.state.currentTime.toFixed(2)}s (${Math.floor(this.state.currentTime * this.state.fps)}/${this.state.totalFrames})`;
            this.ui.timeInput.value = this.state.currentTime.toFixed(2);
        });
    }

    #drawBackground(layer) {
        const { canvas, ctx } = this.ui;
        const iw = layer.img.width;
        const ih = layer.img.height;
        const userScaleX = layer.scale_x || 1;
        const userScaleY = layer.scale_y || 1;
        
        ctx.save();
        ctx.translate(canvas.width / 2 + (layer.x || 0), canvas.height / 2 + (layer.y || 0));
        ctx.rotate(((layer.rotation || 0) * Math.PI) / 180);
        
        // Handle Flip for background
        const flipX = (layer.flip_h > 0.5) ? -1 : 1;
        const flipY = (layer.flip_v > 0.5) ? -1 : 1;
        
        if (layer.bg_mode === "stretch") {
            const drawW = canvas.width * userScaleX;
            const drawH = canvas.height * userScaleY;
            ctx.scale(flipX, flipY);
            ctx.drawImage(layer.img, -drawW / 2, -drawH / 2, drawW, drawH);
        } else {
            let baseScale;
            if (layer.bg_mode === "fit") {
                baseScale = Math.min(canvas.width / iw, canvas.height / ih);
            } else { // fill
                baseScale = Math.max(canvas.width / iw, canvas.height / ih);
            }
            // Apply scale X/Y and Flips
            ctx.scale(baseScale * userScaleX * flipX, baseScale * userScaleY * flipY);
            ctx.drawImage(layer.img, -iw / 2, -ih / 2);
        }
        
        ctx.restore();
    }

    #drawBezier(path) {
        const ctx = this.ui.ctx;
        ctx.save();
        ctx.strokeStyle = "#ff00ff";
        ctx.lineWidth = 3;
        
        const points = path.points || [path.p0, path.p1, path.p2, path.p3];
        
        if (points.length >= 2) {
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            
            if (points.length >= 4) {
                for (let i = 0; i < points.length - 3; i += 3) {
                    ctx.bezierCurveTo(
                        points[i + 1].x, points[i + 1].y,
                        points[i + 2].x, points[i + 2].y,
                        points[i + 3].x, points[i + 3].y
                    );
                }
            } else {
                for (let i = 1; i < points.length; i++) {
                    ctx.lineTo(points[i].x, points[i].y);
                }
            }
            ctx.stroke();
            
            points.forEach((p, idx) => {
                ctx.fillStyle = idx % 3 === 0 ? "#ff0" : "#ff00ff"; 
                ctx.beginPath();
                ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
                ctx.fill();
            });

            const lastIdx = points.length - 1;
            const prevIdx = Math.max(0, lastIdx - 1);
            const endPoint = points[lastIdx];
            const prevPoint = points[prevIdx];
            const dirX = endPoint.x - prevPoint.x;
            const dirY = endPoint.y - prevPoint.y;
            const magnitude = Math.hypot(dirX, dirY) || 1;
            const arrowLength = Math.min(18, magnitude * 0.6);
            const arrowWidth = Math.min(8, magnitude * 0.3);
            const angle = Math.atan2(dirY, dirX);

            ctx.save();
            ctx.translate(endPoint.x, endPoint.y);
            ctx.rotate(angle);
            ctx.fillStyle = "#ff00ff";
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(-arrowLength, arrowWidth);
            ctx.lineTo(-arrowLength * 0.6, 0);
            ctx.lineTo(-arrowLength, -arrowWidth);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
        ctx.restore();
    }

    #drawTimeline() {
        const ctx = this.ui.timelineCtx;
        const canvas = this.ui.timelineCanvas;
        ctx.fillStyle = "#252525";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "#3c3c3c";
        ctx.fillStyle = "#666";
        ctx.font = "8px monospace";
        for (let i = 0; i <= 10; i += 1) {
            const x = (i / 10) * canvas.width;
            const time = (i / 10) * this.state.duration;
            ctx.beginPath();
            ctx.moveTo(x, 10);
            ctx.lineTo(x, 15);
            ctx.stroke();
            ctx.fillText(`${time.toFixed(1)}s`, x - 8, 9);
            ctx.fillStyle = "#555";
            ctx.fillText(`F${Math.floor(time * this.state.fps)}`, x - 8, 22);
            ctx.fillStyle = "#666";
        }
        this.state.layers.forEach((layer) => {
            KF_PROPS.forEach((prop) => {
                (layer.keyframes[prop] || []).forEach((kf) => {
                    const px = (kf.time / this.state.duration) * canvas.width;
                    if (layer.type === "background") {
                        ctx.fillStyle = layer.id === this.state.selectedId ? "#5cc5ff" : "#5cffaf";
                    } else {
                        ctx.fillStyle = layer.id === this.state.selectedId ? "#ff5c5c" : "#5cff5c";
                    }
                    ctx.fillRect(px - 2, 28, 4, 12);
                });
            });
        });
        const markerX = (this.state.currentTime / this.state.duration) * canvas.width;
        ctx.strokeStyle = "#fff";
        ctx.beginPath();
        ctx.moveTo(markerX, 0);
        ctx.lineTo(markerX, canvas.height);
        ctx.stroke();
    }

    #updateForm() {
        const layer = this.#currentLayer();
        const ui = this.ui;
        if (!layer) {
            ui.fgRow.style.display = "none";
            ui.bgSelect.style.display = "none";
            return;
        }
        const isForeground = layer.type !== "background";
        ui.fgRow.style.display = isForeground ? "flex" : "none";
        ui.bgSelect.style.display = isForeground ? "none" : "inline-block";
        ui.bgRow.style.display = isForeground ? "none" : "flex";
        
        if (isForeground) {
            ui.inputs.x.value = layer.x.toFixed(0);
            ui.inputs.y.value = layer.y.toFixed(0);
            // Update individual scale inputs
            ui.inputs.scale_x.value = (layer.scale_x || 1).toFixed(2);
            ui.inputs.scale_y.value = (layer.scale_y || 1).toFixed(2);
            ui.inputs.rotation.value = layer.rotation.toFixed(0);
            ui.inputs.opacity.value = layer.opacity.toFixed(2);
            ui.inputs.mask_size.value = layer.mask_size.toFixed(2);
            ui.inputs.flip_h.checked = layer.flip_h > 0.5;
            ui.inputs.flip_v.checked = layer.flip_v > 0.5;
        } else {
            ui.bgSelect.value = layer.bg_mode || "fit";
            ui.bgInputs.x.value = (layer.x || 0).toFixed(0);
            ui.bgInputs.y.value = (layer.y || 0).toFixed(0);
            ui.bgInputs.scale_x.value = (layer.scale_x || 1).toFixed(2);
            ui.bgInputs.scale_y.value = (layer.scale_y || 1).toFixed(2);
            ui.bgInputs.rotation.value = (layer.rotation || 0).toFixed(0);
            ui.bgInputs.flip_h.value = (layer.flip_h || 0);
            ui.bgInputs.flip_v.value = (layer.flip_v || 0);
        }
    }

    #persist(includeImageCache = false) {
        if (!this.widgets.keyframes) return;
        
        if (this._persistTimer) clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            const payload = this.state.layers.map((layer) => {
                const save = { 
                    id: layer.id,
                    name: layer.name,
                    type: layer.type,
                    keyframes: layer.keyframes
                };
                const isExtracted = layer.id && layer.id.startsWith("extracted_");
                const isUploaded = layer.id && layer.id.startsWith("uploaded_");
                if ((includeImageCache || isExtracted || isUploaded || layer.type === "background") && layer.image_data) {
                    save.image_data = layer.image_data;
                }
                
                // Common props including flip and separate scales
                save.flip_h = layer.flip_h || 0;
                save.flip_v = layer.flip_v || 0;
                save.scale_x = layer.scale_x !== undefined ? layer.scale_x : 1;
                save.scale_y = layer.scale_y !== undefined ? layer.scale_y : 1;
                // Keep 'scale' for legacy compatibility, effectively unused in UI now
                save.scale = 1; 

                if (layer.type === "background") {
                    save.bg_mode = layer.bg_mode;
                    if (layer.x) save.x = layer.x;
                    if (layer.y) save.y = layer.y;
                    if (layer.rotation) save.rotation = layer.rotation;
                } else {
                    save.x = layer.x !== undefined ? layer.x : 0;
                    save.y = layer.y !== undefined ? layer.y : 0;
                    save.rotation = layer.rotation !== undefined ? layer.rotation : 0;
                    save.opacity = layer.opacity !== undefined ? layer.opacity : 1;
                    save.mask_size = layer.mask_size !== undefined ? layer.mask_size : 1;
                    if (layer.customMask) save.customMask = layer.customMask;
                    if (layer.bezierPath) save.bezierPath = layer.bezierPath;
                }
                return save;
            });
            this.widgets.keyframes.value = JSON.stringify(payload);
            
            if (this.widgets.keyframes.inputEl) {
                this.widgets.keyframes.inputEl.value = this.widgets.keyframes.value;
                this.widgets.keyframes.inputEl.dispatchEvent(new Event("input"));
            }
            this.node.setDirtyCanvas?.(true, false);
        }, 300);
    }

    #syncLayerSelect() {
        const select = this.ui.layerSelect;
        select.innerHTML = this.state.layers.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
        if (!this.state.layers.length) {
            this.state.selectedId = null;
            return;
        }
        const exists = this.state.layers.some((l) => l.id === this.state.selectedId);
        if (!exists) {
            this.state.selectedId = this.state.layers[0].id;
        }
        select.value = this.state.selectedId;
    }

    #setResolution(width, height, { userInitiated = false } = {}) {
        const nextWidth = this.#coerceInt(width, this.state.width, { min: 64, max: 8192 });
        const nextHeight = this.#coerceInt(height, this.state.height, { min: 64, max: 8192 });
        if (nextWidth === this.state.width && nextHeight === this.state.height) {
            if (this.ui.widthInput) this.ui.widthInput.value = nextWidth;
            if (this.ui.heightInput) this.ui.heightInput.value = nextHeight;
            return;
        }
        this.state.width = nextWidth;
        this.state.height = nextHeight;
        if (this.ui.widthInput) this.ui.widthInput.value = nextWidth;
        if (this.ui.heightInput) this.ui.heightInput.value = nextHeight;
        if (this.ui.canvas) {
            const previewW = Math.min(nextWidth, 1920);
            const previewH = Math.min(nextHeight, 1080);
            this.ui.canvas.width = previewW;
            this.ui.canvas.height = previewH;
            this.ui.canvas.style.aspectRatio = `${previewW}/${previewH}`;
        }
        if (this.widgets.width) {
            this.widgets.width.value = nextWidth;
            if (this.widgets.width.inputEl) {
                this.widgets.width.inputEl.value = nextWidth;
                this.widgets.width.inputEl.dispatchEvent(new Event("input"));
            }
        }
        if (this.widgets.height) {
            this.widgets.height.value = nextHeight;
            if (this.widgets.height.inputEl) {
                this.widgets.height.inputEl.value = nextHeight;
                this.widgets.height.inputEl.dispatchEvent(new Event("input"));
            }
        }
        this.#updateInfo();
        if (userInitiated) {
            this.node.setDirtyCanvas?.(true, false);
        }
    }

    #setTimelineMetrics(fps, totalFrames, { userInitiated = false } = {}) {
        const nextFps = this.#coerceInt(fps, this.state.fps, { min: 1, max: 120 });
        const nextFrames = this.#coerceInt(totalFrames, this.state.totalFrames, { min: 1, max: 9999 });
        let changed = false;
        if (nextFps !== this.state.fps) {
            this.state.fps = nextFps;
            changed = true;
            if (this.widgets.fps) {
                this.widgets.fps.value = nextFps;
                this.widgets.fps.inputEl && (this.widgets.fps.inputEl.value = nextFps);
            }
            if (this.ui.fpsInput) {
                this.ui.fpsInput.value = nextFps;
            }
        }
        if (nextFrames !== this.state.totalFrames) {
            this.state.totalFrames = nextFrames;
            changed = true;
            if (this.widgets.totalFrames) {
                this.widgets.totalFrames.value = nextFrames;
                if (this.widgets.totalFrames.inputEl) {
                    this.widgets.totalFrames.inputEl.value = nextFrames;
                }
            }
            if (this.ui.frameCount) {
                this.ui.frameCount.value = nextFrames;
            }
        }
        this.state.duration = this.state.totalFrames / Math.max(this.state.fps, 1);
        if (changed) {
            this.#drawTimeline();
            this.#updateInfo();
            this.#persist();
            if (userInitiated) {
                this.node.setDirtyCanvas?.(true, false);
            }
        }
    }

    #updateInfo() {
        if (!this.ui?.info) return;
        this.ui.info.textContent = `${this.state.width}×${this.state.height} | ${this.state.fps}fps | ${this.state.duration.toFixed(1)}s`;
    }

    async #handleImageFiles(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return;
        const ui = this.ui;
        ui.addImageBtn.disabled = true;
        ui.addImageBtn.textContent = "Importing...";
        try {
            for (const file of files) {
                await this.#yieldToFrame();
                const scaled = await this.#prepareImageForCanvas(file);
                const layerId = `uploaded_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
                const displayName = file.name?.replace(/\.[^.]+$/, "") || `Image ${this.state.layers.length + 1}`;
                const newLayer = {
                    id: layerId,
                    name: displayName,
                    type: "foreground",
                    image_data: scaled.dataUrl,
                    keyframes: {},
                    x: 0,
                    y: 0,
                    scale_x: 1,
                    scale_y: 1,
                    rotation: 0,
                    opacity: 1,
                    mask_size: 1,
                    flip_h: 0,
                    flip_v: 0,
                    customMask: null,
                    bezierPath: null,
                    img: scaled.img
                };
                this.state.layers.push(newLayer);
                this.state.selectedId = layerId;

                this.#syncLayerSelect();
                this.#render();
                this.#updateForm();
                this.#drawTimeline();
                this.#persist(true);
            }
        } catch (error) {
            console.error("[AE] Failed to import images", error);
            alert("Failed to add image. Check file format.");
        } finally {
            ui.addImageInput.value = "";
            ui.addImageBtn.disabled = false;
            ui.addImageBtn.textContent = "＋Image";
        }
    }

    async #handleBackgroundFile(file) {
        if (!file) return;
        const ui = this.ui;
        ui.addBgBtn.disabled = true;
        ui.addBgBtn.textContent = "Importing...";
        try {
            const scaled = await this.#prepareImageForCanvas(file);
            let bgLayer = this.state.layers.find((l) => l.id === "background");
            if (!bgLayer) {
                bgLayer = {
                    id: "background",
                    name: "Background",
                    type: "background",
                    image_data: scaled.dataUrl,
                    keyframes: {},
                    bg_mode: "fit",
                    x: 0,
                    y: 0,
                    scale_x: 1,
                    scale_y: 1,
                    rotation: 0,
                    flip_h: 0,
                    flip_v: 0,
                    img: scaled.img
                };
                this.state.layers.unshift(bgLayer);
            } else {
                bgLayer.image_data = scaled.dataUrl;
                bgLayer.img = scaled.img;
            }
            this.#syncLayerSelect();
            this.#render();
            this.#persist(true);
            alert("Background updated");
        } catch (error) {
            console.error("[AE] Failed to import background", error);
            alert("Failed to add background. Check file format.");
        } finally {
            ui.addBgInput.value = "";
            ui.addBgBtn.disabled = false;
            ui.addBgBtn.textContent = "＋Background";
        }
    }

    #readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    #createImageFromDataURL(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    async #prepareImageForCanvas(file) {
        const dataUrl = await this.#readFileAsDataURL(file);
        const img = await this.#createImageFromDataURL(dataUrl);
        return this.#fitImageToCanvas(img, dataUrl);
    }

    async #fitImageToCanvas(img, dataUrl) {
        const maxW = this.state.width;
        const maxH = this.state.height;
        if (!img.width || !img.height) {
            return { dataUrl, img };
        }
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        if (scale >= 1) {
            return { dataUrl, img };
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(img.width * scale));
        canvas.height = Math.max(1, Math.floor(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const scaledDataUrl = canvas.toDataURL("image/png");
        const scaledImg = await this.#createImageFromDataURL(scaledDataUrl);
        return { dataUrl: scaledDataUrl, img: scaledImg };
    }

    #ensureLayerImage(layer) {
        if (!layer || !layer.image_data || layer._imgLoading) return;
        layer._imgLoading = true;
        this.#createImageFromDataURL(layer.image_data)
            .then((img) => {
                layer.img = img;
            })
            .catch((err) => console.warn("[AE] Lazy load failed", err))
            .finally(() => {
                layer._imgLoading = false;
                this.#render();
            });
    }

    #clearUnusedCache() {
        const current = this.state.selectedId;
        let cleared = 0;
        this.state.layers.forEach((layer) => {
            if (layer.id === current) return;
            if (layer.img) {
                delete layer.img;
                cleared += 1;
            }
        });
        alert(cleared ? `Cleared ${cleared} cached layers` : "No cache to clear");
        this.#render();
    }

    #writeBoolWidget(widget, value) {
        if (!widget) return;
        widget.value = !!value;
        const el = widget.inputEl;
        if (el) {
            if (Object.prototype.hasOwnProperty.call(el, "checked")) {
                el.checked = !!value;
            } else {
                el.value = value ? "true" : "false";
            }
            el.dispatchEvent(new Event("input"));
        }
        this.node.setDirtyCanvas?.(true, false);
    }

    #yieldToFrame() {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }

    #coerceInt(value, fallback, { min, max } = {}) {
        let next = parseInt(value, 10);
        if (Number.isNaN(next)) {
            next = fallback;
        }
        if (typeof min === "number") {
            next = Math.max(min, next);
        }
        if (typeof max === "number") {
            next = Math.min(max, next);
        }
        return next;
    }

    #normalizeLayer(layer) {
        // Compatibility: handle legacy 'scale' if new separate scales don't exist
        let sx = layer.scale_x !== undefined ? layer.scale_x : (layer.scale !== undefined ? layer.scale : 1);
        let sy = layer.scale_y !== undefined ? layer.scale_y : (layer.scale !== undefined ? layer.scale : 1);
        
        return {
            id: layer.id,
            name: layer.name || layer.id,
            type: layer.type || "foreground",
            image_data: layer.image_data || null,
            keyframes: layer.keyframes || {},
            x: layer.x || 0,
            y: layer.y || 0,
            scale_x: sx,
            scale_y: sy,
            scale: 1, // Reset unified scale
            rotation: layer.rotation || 0,
            opacity: layer.opacity !== undefined ? layer.opacity : 1,
            mask_size: layer.mask_size !== undefined ? layer.mask_size : 1,
            flip_h: layer.flip_h || 0,
            flip_v: layer.flip_v || 0,
            bg_mode: layer.bg_mode || "fit",
            customMask: layer.customMask || null,
            bezierPath: layer.bezierPath || null,
            img: null
        };
    }

    #applyMaskJitter() {
        if (!this.state.mask.enabled) {
            alert("Please enter Mask mode first");
            return;
        }
        const canvas = this.ui.maskCanvas;
        if (!canvas.width || !canvas.height) {
            alert("Please load or draw a mask first");
            return;
        }
        const ctx = this.ui.maskCtx;
        const width = canvas.width;
        const height = canvas.height;
        const src = ctx.getImageData(0, 0, width, height);
        const dst = ctx.createImageData(width, height);
        const amount = this.state.jitter.amount;
        const randUnit = () => {
            const theta = Math.random() * Math.PI * 2;
            const r = Math.random();
            return {
                x: Math.round(Math.cos(theta) * amount * r),
                y: Math.round(Math.sin(theta) * amount * r)
            };
        };
        for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
                const { x: ox, y: oy } = randUnit();
                const sx = Math.min(width - 1, Math.max(0, x + ox));
                const sy = Math.min(height - 1, Math.max(0, y + oy));
                const dstIdx = (y * width + x) * 4;
                const srcIdx = (sy * width + sx) * 4;
                dst.data[dstIdx] = src.data[srcIdx];
                dst.data[dstIdx + 1] = src.data[srcIdx + 1];
                dst.data[dstIdx + 2] = src.data[srcIdx + 2];
                dst.data[dstIdx + 3] = src.data[srcIdx + 3];
            }
        }
        ctx.putImageData(dst, 0, 0);
        alert("Jitter applied to mask. Adjust intensity with the slider.");
    }

    async #executeNode() {
        if (!window.app || typeof window.app.queuePrompt !== "function") {
            alert("ComfyUI API not available. Please queue prompt manually.");
            return;
        }
        this.state.forceServerReload = true;
        this.ui.runBtn.disabled = true;
        const originalLabel = this.ui.runBtn.textContent;
        this.ui.runBtn.textContent = "Running...";
        this.#writeBoolWidget(this.widgets.previewFlag, true);
        try {
            const maybePromise = window.app.queuePrompt?.();
            if (maybePromise?.then) {
                await maybePromise;
            }
        } catch (err) {
            console.error("[AE] queuePrompt error", err);
            alert("Execution failed. Check console.");
        } finally {
            this.#writeBoolWidget(this.widgets.previewFlag, false);
            this.ui.runBtn.disabled = false;
            this.ui.runBtn.textContent = originalLabel;
        }
    }

    #cloneAnimation(animation) {
        return animation ? JSON.parse(JSON.stringify(animation)) : null;
    }

    #addKeyframe() {
        const layer = this.#currentLayer();
        if (!layer) return;
        // Allow keyframes for both foreground and background layers
        KF_PROPS.forEach((prop) => {
            if (!layer.keyframes[prop]) layer.keyframes[prop] = [];
            layer.keyframes[prop] = layer.keyframes[prop].filter((kf) => kf.time.toFixed(2) !== this.state.currentTime.toFixed(2));
            layer.keyframes[prop].push({ time: this.state.currentTime, value: layer[prop] });
            layer.keyframes[prop].sort((a, b) => a.time - b.time);
        });
        this.#persist();
        this.#drawTimeline();
    }

    #deleteKeyframe() {
        const layer = this.#currentLayer();
        if (!layer) return;
        let modified = false;
        KF_PROPS.forEach((prop) => {
            if (!layer.keyframes[prop]) return;
            const prev = layer.keyframes[prop].length;
            layer.keyframes[prop] = layer.keyframes[prop].filter((kf) => kf.time.toFixed(2) !== this.state.currentTime.toFixed(2));
            if (layer.keyframes[prop].length !== prev) modified = true;
        });
        if (modified) {
            this.#applyTime(this.state.currentTime);
            this.#persist();
        }
    }

    #clearKeyframes() {
        const layer = this.#currentLayer();
        if (!layer) return;
        if (window.confirm(`Are you sure you want to clear ALL keyframes for layer "${layer.name}"?`)) {
            layer.keyframes = {};
            this.#applyTime(this.state.currentTime);
            this.#persist();
        }
    }

    #moveLayer(direction) {
        const layer = this.#currentLayer();
        if (!layer) return;
        const idx = this.state.layers.indexOf(layer);
        if (idx === -1) return;
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= this.state.layers.length) return;
        // Swap layers
        [this.state.layers[idx], this.state.layers[newIdx]] = [this.state.layers[newIdx], this.state.layers[idx]];
        this.#updateLayerSelect();
        this.#render();
        this.#persist();
        this.#updateInfo();
    }

    #moveLayerToTop() {
        const layer = this.#currentLayer();
        if (!layer) return;
        const idx = this.state.layers.indexOf(layer);
        if (idx === -1 || idx === this.state.layers.length - 1) return;
        this.state.layers.splice(idx, 1);
        this.state.layers.push(layer);
        this.#updateLayerSelect();
        this.#render();
        this.#persist();
    }

    #moveLayerToBottom() {
        const layer = this.#currentLayer();
        if (!layer) return;
        const idx = this.state.layers.indexOf(layer);
        if (idx === -1 || idx === 0) return;
        this.state.layers.splice(idx, 1);
        this.state.layers.unshift(layer);
        this.#updateLayerSelect();
        this.#render();
        this.#persist();
    }

    #updateLayerSelect() {
        const select = this.ui.layerSelect;
        select.innerHTML = this.state.layers.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
        select.value = this.state.selectedId;
    }

    #toggleMaskMode() {
        this.state.mask.enabled = !this.state.mask.enabled;
        if (this.state.mask.enabled) {
            this.state.path.enabled = false;
            this.ui.pathApplyBtn.style.display = "none";
            this.ui.pathAddBtn.style.display = "none";
            this.ui.canvas.style.cursor = "crosshair";
            this.ui.maskApplyBtn.style.display = "inline-block";
            this.ui.maskJitterBtn.style.display = "inline-block";
            this.ui.maskJitterInput.style.display = "inline-block";
            this.ui.maskJitterValue.style.display = "inline";
            this.ui.maskBrushLabel.style.display = "inline";
            this.ui.maskBrushInput.style.display = "inline-block";
            this.ui.maskBrushValue.style.display = "inline";
            
            // Initialize brush size from state
            this.ui.maskBrushInput.value = this.state.mask.brush;
            this.ui.maskBrushValue.textContent = this.state.mask.brush;
            
            const layer = this.#currentLayer();
            if (layer && layer.type !== "background" && layer.img) {
                this.ui.maskCanvas.width = layer.img.width;
                this.ui.maskCanvas.height = layer.img.height;
                
                if (layer.customMask) {
                    const img = new Image();
                    img.onload = () => this.ui.maskCtx.drawImage(img, 0, 0, layer.img.width, layer.img.height);
                    img.src = layer.customMask;
                } else {
                    this.ui.maskCtx.fillStyle = "white";
                    this.ui.maskCtx.fillRect(0, 0, layer.img.width, layer.img.height);
                }
            }
        } else {
            this.ui.canvas.style.cursor = "default";
            this.ui.maskApplyBtn.style.display = "none";
            this.ui.maskJitterBtn.style.display = "none";
            this.ui.maskJitterInput.style.display = "none";
            this.ui.maskJitterValue.style.display = "none";
            this.ui.maskBrushLabel.style.display = "none";
            this.ui.maskBrushInput.style.display = "none";
            this.ui.maskBrushValue.style.display = "none";
        }
        this.#render();
    }

    #applyMask() {
        const layer = this.#currentLayer();
        if (!layer || layer.type === "background") {
            alert("Please select a foreground layer");
            return;
        }
        if (this.state.mask.drawing) {
            alert("Please finish drawing first");
            return;
        }
        const maskData = this.ui.maskCanvas.toDataURL();
        layer.customMask = maskData;
        this.#persist();
        alert("Mask applied to layer");
    }

    #addPathPoint() {
        if (!this.state.path.enabled || !this.state.path.data) return;
        const layer = this.#currentLayer();
        if (!layer) return;
        
        if (!this.state.path.data.points) {
            this.state.path.data.points = [
                this.state.path.data.p0,
                this.state.path.data.p1,
                this.state.path.data.p2,
                this.state.path.data.p3
            ];
        }
        
        const points = this.state.path.data.points;
        if (points.length < 4) {
            alert("Path needs at least 4 points to add a segment");
            return;
        }
        
        const lastPoint = points[points.length - 1];
        const offset = 100;
        
        points.push(
            { x: lastPoint.x + offset, y: lastPoint.y - offset },  
            { x: lastPoint.x + offset * 2, y: lastPoint.y + offset },  
            { x: lastPoint.x + offset * 3, y: lastPoint.y }  
        );
        
        layer.bezierPath = this.state.path.data;
        
        this.#render();
        this.#persist();
    }

    #togglePathMode() {
        this.state.path.enabled = !this.state.path.enabled;
        if (this.state.path.enabled) {
            this.state.mask.enabled = false;
            this.ui.maskApplyBtn.style.display = "none";
            this.ui.pathApplyBtn.style.display = "inline-block";
            this.ui.pathAddBtn.style.display = "inline-block";
            const layer = this.#currentLayer();
            if (!layer) {
                this.state.path.enabled = false;
                alert("Please select a layer first");
                return;
            }
            if (layer.bezierPath) {
                this.state.path.data = layer.bezierPath;
            } else {
                const cx = this.ui.canvas.width / 2;
                const cy = this.ui.canvas.height / 2;
                this.state.path.data = {
                    p0: { x: cx - 200, y: cy },
                    p1: { x: cx - 100, y: cy - 100 },
                    p2: { x: cx + 100, y: cy + 100 },
                    p3: { x: cx + 200, y: cy }
                };
                layer.bezierPath = this.state.path.data;
            }
        } else {
            const layer = this.#currentLayer();
            if (layer && this.state.path.data) layer.bezierPath = this.state.path.data;
            this.ui.pathApplyBtn.style.display = "none";
            this.ui.pathAddBtn.style.display = "none";
        }
        this.#render();
        this.#persist();
    }

    #applyPathToKeyframes() {
        const layer = this.#currentLayer();
        if (!layer || !this.state.path.data) {
            alert("Please set a bezier path first");
            return;
        }
        
        const segments = parseInt(prompt("How many keyframes to generate?", "10"), 10);
        if (!segments || segments < 2) return;
        
        layer.keyframes.x = [];
        layer.keyframes.y = [];
        
        const path = this.state.path.data;
        const points = path.points || [path.p0, path.p1, path.p2, path.p3];
        const centerX = this.ui.canvas.width / 2;
        const centerY = this.ui.canvas.height / 2;
        
        const getBezierPoint = (t) => {
            if (points.length < 4) {
                const idx = t * (points.length - 1);
                const i1 = Math.floor(idx);
                const i2 = Math.min(i1 + 1, points.length - 1);
                const frac = idx - i1;
                return {
                    x: points[i1].x + (points[i2].x - points[i1].x) * frac,
                    y: points[i1].y + (points[i2].y - points[i1].y) * frac
                };
            }
            
            const numSegments = Math.floor((points.length - 1) / 3);
            const segmentT = t * numSegments;
            const segmentIdx = Math.min(Math.floor(segmentT), numSegments - 1);
            const localT = segmentT - segmentIdx;
            
            const startIdx = segmentIdx * 3;
            const p0 = points[startIdx];
            const p1 = points[startIdx + 1];
            const p2 = points[startIdx + 2];
            const p3 = points[startIdx + 3];
            
            const mt = 1 - localT;
            const mt2 = mt * mt;
            const mt3 = mt2 * mt;
            const t2 = localT * localT;
            const t3 = t2 * localT;
            
            return {
                x: mt3 * p0.x + 3 * mt2 * localT * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
                y: mt3 * p0.y + 3 * mt2 * localT * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y
            };
        };
        
        for (let i = 0; i <= segments; i++) {
            const t = i / segments;
            const time = t * this.state.duration;
            const pt = getBezierPoint(t);
            
            layer.keyframes.x.push({ time, value: pt.x - centerX });
            layer.keyframes.y.push({ time, value: pt.y - centerY });
        }
        
        this.#applyTime(this.state.currentTime);
        this.#persist();
        alert(`Generated ${segments + 1} keyframes`);
    }

    #startPlayback() {
        if (this.state.playing) return;
        this.state.playing = true;
        const start = performance.now();
        const origin = this.state.currentTime;
        const tick = () => {
            if (!this.state.playing) return;
            const elapsed = (performance.now() - start) / 1000;
            const next = (origin + elapsed) % this.state.duration;
            this.#applyTime(next);
            this.state.rafId = requestAnimationFrame(tick);
        };
        tick();
    }

    #stopPlayback() {
        this.state.playing = false;
        if (this.state.rafId) cancelAnimationFrame(this.state.rafId);
    }

    #refreshFromCache() {
        if (this._lastServerAnimation) {
            if (window.confirm("Overwrite current edits with latest server animation?")) {
                const payload = this.#cloneAnimation(this._lastServerAnimation);
                this.state.forceServerReload = false;
                this.load(payload);
            }
            return;
        }
        alert("No server cache found. Please run the AE Animation Core node first.");
    }

    #toggleExtractMode() {
        this.state.extract.enabled = !this.state.extract.enabled;
        if (this.state.extract.enabled) {
            this.state.mask.enabled = false;
            this.state.path.enabled = false;
            this.ui.maskApplyBtn.style.display = "none";
            this.ui.pathApplyBtn.style.display = "none";
            this.ui.pathAddBtn.style.display = "none";
            
            const bgLayer = this.state.layers.find(l => l.type === "background");
            if (!bgLayer || !bgLayer.img) {
                this.state.extract.enabled = false;
                alert("Background layer required for extraction");
                return;
            }
            
            this.ui.extractCanvas.width = bgLayer.img.width;
            this.ui.extractCanvas.height = bgLayer.img.height;
            this.ui.extractCtx.fillStyle = "black";
            this.ui.extractCtx.fillRect(0, 0, bgLayer.img.width, bgLayer.img.height);
            
            this.ui.extractBrushInput.value = this.state.extract.brush;
            this.ui.extractBrushValue.textContent = this.state.extract.brush;
            
            this.ui.canvas.style.cursor = "crosshair";
            this.ui.extractBrushLabel.style.display = "inline";
            this.ui.extractBrushInput.style.display = "inline";
            this.ui.extractBrushValue.style.display = "inline";
            this.ui.extractBlurLabel.style.display = "inline";
            this.ui.extractBlurSelect.style.display = "inline-block";
            this.ui.extractApplyBtn.style.display = "inline-block";
        } else {
            this.ui.canvas.style.cursor = "default";
            this.ui.extractBrushLabel.style.display = "none";
            this.ui.extractBrushInput.style.display = "none";
            this.ui.extractBrushValue.style.display = "none";
            this.ui.extractBlurLabel.style.display = "none";
            this.ui.extractBlurSelect.style.display = "none";
            this.ui.extractApplyBtn.style.display = "none";
        }
        this.#render();
    }

    #applyExtraction() {
        const bgLayer = this.state.layers.find(l => l.type === "background");
        if (!bgLayer || !bgLayer.img) {
            alert("Background layer missing");
            return;
        }
        
        const extractMask = this.ui.extractCtx.getImageData(0, 0, this.ui.extractCanvas.width, this.ui.extractCanvas.height);
        const hasSelection = extractMask.data.some((v, i) => i % 4 === 0 && v > 128);
        if (!hasSelection) {
            alert("Please draw a selection first");
            return;
        }
        
        const blurType = this.state.extract.blurType;
        const bgW = bgLayer.img.width;
        const bgH = bgLayer.img.height;
        
        const fgCanvas = document.createElement("canvas");
        fgCanvas.width = bgW;
        fgCanvas.height = bgH;
        const fgCtx = fgCanvas.getContext("2d");
        
        const tempBg = document.createElement("canvas");
        tempBg.width = bgW;
        tempBg.height = bgH;
        const tempBgCtx = tempBg.getContext("2d");
        tempBgCtx.drawImage(bgLayer.img, 0, 0);
        const bgData = tempBgCtx.getImageData(0, 0, bgW, bgH);
        
        const fgData = fgCtx.createImageData(bgW, bgH);
        for (let i = 0; i < bgData.data.length; i += 4) {
            const maskVal = extractMask.data[i]; 
            if (maskVal > 128) {
                fgData.data[i] = bgData.data[i];
                fgData.data[i + 1] = bgData.data[i + 1];
                fgData.data[i + 2] = bgData.data[i + 2];
                fgData.data[i + 3] = 255;
            } else {
                fgData.data[i + 3] = 0; 
            }
        }
        fgCtx.putImageData(fgData, 0, 0);
        
        const blurredBg = document.createElement("canvas");
        blurredBg.width = bgW;
        blurredBg.height = bgH;
        const blurredCtx = blurredBg.getContext("2d");
        blurredCtx.drawImage(bgLayer.img, 0, 0);
        
        const maxBlurSize = Math.max(bgW, bgH) / 5;
        if (blurType === 'gaussian') {
            blurredCtx.filter = `blur(${Math.min(maxBlurSize, 100)}px)`;
            blurredCtx.drawImage(bgLayer.img, 0, 0);
            blurredCtx.filter = 'none';
        } else { 
            for (let i = 0; i < 5; i++) {
                blurredCtx.globalAlpha = 0.3;
                blurredCtx.filter = `blur(${Math.min(maxBlurSize / (i + 1), 80)}px)`;
                blurredCtx.drawImage(bgLayer.img, 0, 0);
            }
            blurredCtx.filter = 'none';
            blurredCtx.globalAlpha = 1.0;
        }
        
        const finalBg = document.createElement("canvas");
        finalBg.width = bgW;
        finalBg.height = bgH;
        const finalBgCtx = finalBg.getContext("2d");
        finalBgCtx.drawImage(bgLayer.img, 0, 0); 
        
        const blurredData = blurredCtx.getImageData(0, 0, bgW, bgH);
        const finalData = finalBgCtx.getImageData(0, 0, bgW, bgH);
        
        for (let i = 0; i < finalData.data.length; i += 4) {
            const maskVal = extractMask.data[i];
            if (maskVal > 128) {
                finalData.data[i] = blurredData.data[i];
                finalData.data[i + 1] = blurredData.data[i + 1];
                finalData.data[i + 2] = blurredData.data[i + 2];
            }
        }
        finalBgCtx.putImageData(finalData, 0, 0);
        
        bgLayer.image_data = finalBg.toDataURL();
        
        const canvasW = this.ui.canvas.width;
        const canvasH = this.ui.canvas.height;
        
        const displayW = canvasW;
        const displayH = canvasH;
        const resizedFg = document.createElement("canvas");
        resizedFg.width = displayW;
        resizedFg.height = displayH;
        const resizedCtx = resizedFg.getContext("2d");
        resizedCtx.drawImage(fgCanvas, 0, 0, bgW, bgH, 0, 0, displayW, displayH);
        
        const extractedCount = this.state.layers.filter(l => l.id && l.id.startsWith("extracted_")).length;
        const newLayerId = `extracted_${extractedCount}`;
        
        const newLayer = {
            id: newLayerId,
            name: `Extracted ${extractedCount + 1}`,
            type: "foreground",
            image_data: resizedFg.toDataURL(), 
            keyframes: {},
            x: 0,
            y: 0,
            scale_x: 1,
            scale_y: 1,
            rotation: 0,
            opacity: 1,
            mask_size: 1,
            flip_h: 0,
            flip_v: 0,
            customMask: null,
            bezierPath: null,
            img: null
        };
        
        const newBgImg = new Image();
        const fgImg = new Image();
        let bgLoaded = false;
        let fgLoaded = false;
        
        const checkComplete = () => {
            if (bgLoaded && fgLoaded) {
                this.state.layers.push(newLayer);
                this.state.selectedId = newLayerId;
                
                const select = this.ui.layerSelect;
                select.innerHTML = this.state.layers.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
                select.value = newLayerId;
                
                this.state.extract.enabled = false;
                this.state.extract.drawing = false;
                this.ui.extractBrushLabel.style.display = "none";
                this.ui.extractBrushInput.style.display = "none";
                this.ui.extractBrushValue.style.display = "none";
                this.ui.extractBlurLabel.style.display = "none";
                this.ui.extractBlurSelect.style.display = "none";
                this.ui.extractApplyBtn.style.display = "none";
                this.ui.canvas.style.cursor = "default";
                
                this.#render();
                
                this.#persist(true);
                alert("✅ Success!\nNew foreground layer created.\nBackground filled and blurred.");
            }
        };
        
        newBgImg.onload = () => {
            bgLayer.img = newBgImg;
            bgLoaded = true;
            checkComplete();
        };
        fgImg.onload = () => {
            newLayer.img = fgImg;
            fgLoaded = true;
            checkComplete();
        };
        
        newBgImg.src = bgLayer.image_data;
        fgImg.src = newLayer.image_data;
    }

    #canvasPosition(event) {
        const rect = this.ui.canvas.getBoundingClientRect();
        const sx = this.ui.canvas.width / rect.width;
        const sy = this.ui.canvas.height / rect.height;
        return {
            x: (event.clientX - rect.left) * sx,
            y: (event.clientY - rect.top) * sy
        };
    }

    #canvasToLayerCoords(canvasPos, layer) {
        const cx = this.ui.canvas.width / 2 + layer.x;
        const cy = this.ui.canvas.height / 2 + layer.y;
        
        let x = canvasPos.x - cx;
        let y = canvasPos.y - cy;
        
        const angleRad = -(layer.rotation * Math.PI / 180);
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        
        // Reverse Separate Scaling + Flip
        const sx = (layer.scale_x || 1) * (layer.flip_h > 0.5 ? -1 : 1);
        const sy = (layer.scale_y || 1) * (layer.flip_v > 0.5 ? -1 : 1);

        const imgX = rx / sx + layer.img.width / 2;
        const imgY = ry / sy + layer.img.height / 2;
        
        return { x: imgX, y: imgY };
    }

    #canvasToBgCoords(canvasPos, bgLayer) {
        const canvasW = this.ui.canvas.width;
        const canvasH = this.ui.canvas.height;
        const bgW = bgLayer.img.width;
        const bgH = bgLayer.img.height;
        const bgMode = bgLayer.bg_mode || "fit";
        const bgX = bgLayer.x || 0;
        const bgY = bgLayer.y || 0;
        
        let baseScale = 1;
        if (bgMode === "fit") {
            baseScale = Math.min(canvasW / bgW, canvasH / bgH);
        } else if (bgMode === "fill") {
            baseScale = Math.max(canvasW / bgW, canvasH / bgH);
        } else { // stretch
            baseScale = 1;
        }
        
        // bgScaleX/Y could also be used here if needed for extract mode, but simplifying for now
        const finalScale = baseScale * (bgLayer.scale_x || 1); 
        
        const bgCenterX = canvasW / 2 + bgX;
        const bgCenterY = canvasH / 2 + bgY;
        
        let x = canvasPos.x - bgCenterX;
        let y = canvasPos.y - bgCenterY;
        
        const imgX = x / finalScale + bgW / 2;
        const imgY = y / finalScale + bgH / 2;
        
        return { x: imgX, y: imgY };
    }

    #onCanvasDown(event) {
        const pos = this.#canvasPosition(event);
        if (this.state.extract.enabled) {
            const bgLayer = this.state.layers.find(l => l.type === "background");
            if (!bgLayer || !bgLayer.img) return;
            
            const bgPos = this.#canvasToBgCoords(pos, bgLayer);
            this.state.extract.drawing = true;
            
            const ctx = this.ui.extractCtx;
            ctx.globalCompositeOperation = event.button === 2 || event.shiftKey ? "destination-out" : "source-over";
            ctx.strokeStyle = "white";
            ctx.lineWidth = this.state.extract.brush;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(bgPos.x, bgPos.y);
            event.preventDefault();
            return;
        }
        if (this.state.mask.enabled) {
            const layer = this.#currentLayer();
            if (!layer || !layer.img) return;
            const localPos = this.#canvasToLayerCoords(pos, layer);
            this.state.mask.drawing = true;
            this.state.mask.erase = event.button === 2 || event.shiftKey;
            this.ui.maskCtx.beginPath();
            this.ui.maskCtx.moveTo(localPos.x, localPos.y);
            event.preventDefault();
            return;
        }
        if (this.state.path.enabled && this.state.path.data) {
            const points = this.state.path.data.points || [this.state.path.data.p0, this.state.path.data.p1, this.state.path.data.p2, this.state.path.data.p3];
            for (let i = 0; i < points.length; i++) {
                if (Math.hypot(points[i].x - pos.x, points[i].y - pos.y) < 10) {
                    this.state.path.dragging = i;
                    event.preventDefault();
                    return;
                }
            }
        }
        const layer = this.#currentLayer();
        if (!layer) return;
        this.state.draggingLayer = true;
        this.state.dragOffset.x = pos.x - this.ui.canvas.width / 2 - layer.x;
        this.state.dragOffset.y = pos.y - this.ui.canvas.height / 2 - layer.y;
        event.preventDefault();
    }

    #onCanvasMove(event) {
        const pos = this.#canvasPosition(event);
        if (this.state.extract.drawing && this.state.extract.enabled) {
            const bgLayer = this.state.layers.find(l => l.type === "background");
            if (!bgLayer || !bgLayer.img) return;
            
            const bgPos = this.#canvasToBgCoords(pos, bgLayer);
            const ctx = this.ui.extractCtx;
            ctx.lineTo(bgPos.x, bgPos.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(bgPos.x, bgPos.y);
            
            this.#render();
            event.preventDefault();
            return;
        }
        if (this.state.mask.drawing && this.state.mask.enabled) {
            const layer = this.#currentLayer();
            if (!layer || !layer.img) return;
            const localPos = this.#canvasToLayerCoords(pos, layer);
            const ctx = this.ui.maskCtx;
            
            // Adjust brush size based on average scale
            const avgScale = ((layer.scale_x || 1) + (layer.scale_y || 1)) / 2;
            ctx.lineWidth = this.state.mask.brush / Math.abs(avgScale);
            
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.strokeStyle = this.state.mask.erase ? "rgba(255,255,255,1)" : "rgba(0,0,0,1)";
            ctx.globalCompositeOperation = "source-over";
            ctx.lineTo(localPos.x, localPos.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(localPos.x, localPos.y);
            this.#render();
            event.preventDefault();
            return;
        }
        if (this.state.path.enabled && this.state.path.dragging !== null && this.state.path.data) {
            const points = this.state.path.data.points || [this.state.path.data.p0, this.state.path.data.p1, this.state.path.data.p2, this.state.path.data.p3];
            if (this.state.path.dragging < points.length) {
                points[this.state.path.dragging] = { x: pos.x, y: pos.y };
                if (this.state.path.data.points) {
                    this.state.path.data.points = points;
                } else {
                    ["p0", "p1", "p2", "p3"].forEach((key, idx) => {
                        if (idx === this.state.path.dragging) this.state.path.data[key] = { x: pos.x, y: pos.y };
                    });
                }
            }
            this.#render();
            event.preventDefault();
            return;
        }
        if (!this.state.draggingLayer) return;
        const layer = this.#currentLayer();
        if (!layer) return;
        layer.x = pos.x - this.ui.canvas.width / 2 - this.state.dragOffset.x;
        layer.y = pos.y - this.ui.canvas.height / 2 - this.state.dragOffset.y;
        this.#updateForm();
        this.#render();
        event.preventDefault();
    }

    #onCanvasUp() {
        if (this.state.extract.drawing) {
            this.state.extract.drawing = false;
            this.#render();
        }
        if (this.state.mask.drawing) {
            const layer = this.#currentLayer();
            if (layer) {
                this.state.mask.drawing = false;
                layer.customMask = this.ui.maskCanvas.toDataURL();
                this.#persist();
            }
        }
        if (this.state.path.dragging !== null && this.state.path.data) {
            const layer = this.#currentLayer();
            if (layer) layer.bezierPath = this.state.path.data;
            this.state.path.dragging = null;
            this.#persist();
        }
        if (this.state.draggingLayer) {
            this.#persist();
        }
        this.state.draggingLayer = false;
    }

    #onCanvasWheel(event) {
        event.preventDefault();
        if (this.state.mask.enabled) {
            this.state.mask.brush = Math.max(5, Math.min(100, this.state.mask.brush + (event.deltaY < 0 ? 2 : -2)));
            return;
        }
        const layer = this.#currentLayer();
        if (!layer) return;
        
        // Update both scales uniformly with wheel
        const factor = (event.deltaY < 0 ? 1.1 : 0.9);
        layer.scale_x = Math.max(0.01, Math.min(5, (layer.scale_x || 1) * factor));
        layer.scale_y = Math.max(0.01, Math.min(5, (layer.scale_y || 1) * factor));
        
        this.#updateForm();
        this.#render();
        this.#persist();
    }

    #timelinePosition(event) {
        const rect = this.ui.timelineCanvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        return { x, y };
    }

    #onTimelineDown(event) {
        const { x, y } = this.#timelinePosition(event);
        const layer = this.#currentLayer();
        if (layer && layer.type !== "background") {
            const hitRadius = 6;
            for (const prop of KF_PROPS) {
                const frames = layer.keyframes[prop] || [];
                for (let i = 0; i < frames.length; i += 1) {
                    const px = frames[i].time / this.state.duration;
                    if (Math.abs(px - x) * this.ui.timelineCanvas.width <= hitRadius && Math.abs(y * this.ui.timelineCanvas.height - 35) <= 12) {
                        this.state.dragKeyframe = { layer, prop, index: i };
                        return;
                    }
                }
            }
        }
        this.#applyTime(x * this.state.duration);
    }

    #onTimelineMove(event) {
        if (!this.state.dragKeyframe) return;
        const { x } = this.#timelinePosition(event);
        const newTime = Math.max(0, Math.min(this.state.duration, x * this.state.duration));
        const { layer, prop, index } = this.state.dragKeyframe;
        const frames = layer.keyframes[prop];
        if (!frames) return;
        frames[index].time = newTime;
        frames.sort((a, b) => a.time - b.time);
        this.#applyTime(newTime);
        this.#persist();
    }

    #onTimelineUp() {
        this.state.dragKeyframe = null;
    }
}

app.registerExtension({
    name: "AE.AnimationEditor",
    async setup() {
        api.addEventListener("ae_animation_update", (event) => {
            const detail = event.detail;
            if (!detail?.node_id) return;
            const view = VIEW_REGISTRY.get(Number(detail.node_id));
            if (view && detail.animation) {
                try {
                    const payload = typeof detail.animation === "string" ? JSON.parse(detail.animation) : detail.animation;
                    view._lastServerAnimation = payload;
                    
                    const hasWidgetData = view.widgets.keyframes?.value && view.widgets.keyframes.value !== "[]";
                    const hasExternalLayers = (payload.layers || []).some(l => 
                        l.id && l.id.startsWith("layer_") && l.type === "foreground"
                    );
                    
                    if (!hasWidgetData || hasExternalLayers || view.state.forceServerReload) {
                        console.log(`[AE] Loading from WebSocket (external: ${hasExternalLayers}, force: ${view.state.forceServerReload})`);
                        view.state.forceServerReload = false;
                        view.load(payload);
                    } else {
                        console.log("[AE] Skipping WebSocket load (preserving user changes)");
                    }
                } catch (err) {
                    console.error("[AE] WS parse error:", err);
                }
            }
        });
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "AEAnimationCore") return;
        const originalOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function onNodeCreated() {
            const result = originalOnCreated?.apply(this, arguments);
            const view = new AeTimelineView(this);
            
            const registerView = () => {
                if (this.id && this.id !== -1) {
                    VIEW_REGISTRY.set(this.id, view);
                } else {
                    setTimeout(registerView, 50);
                }
            };
            registerView();
            
            view.mount();
            const originalOnRemoved = this.onRemoved;
            this.onRemoved = () => {
                view.dispose();
                originalOnRemoved?.apply(this, arguments);
            };
            const originalExecuted = this.onExecuted;
            this.onExecuted = (output) => {
                originalExecuted?.apply(this, arguments);
                const payload = output?.animation?.[0] || output?.animation || output?.ANIMATION?.[0];
                if (!payload) return;
                try {
                    const json = typeof payload === "string" ? JSON.parse(payload) : payload;
                    view._lastServerAnimation = json;
                    
                    const hasWidgetData = view.widgets.keyframes?.value && view.widgets.keyframes.value !== "[]";
                    const hasExternalLayers = (json.layers || []).some(l => 
                        l.id && l.id.startsWith("layer_") && l.type === "foreground"
                    );
                    
                    if (!hasWidgetData || hasExternalLayers || view.state.forceServerReload) {
                        console.log(`[AE] Loading from onExecuted (external: ${hasExternalLayers}, force: ${view.state.forceServerReload})`);
                        view.state.forceServerReload = false;
                        view.load(json);
                    } else {
                        console.log("[AE] Skipping onExecuted load (preserving user changes)");
                    }
                } catch (err) {
                    console.error("[AE] Parse error:", err);
                }
            };
            return result;
        };
    }
});