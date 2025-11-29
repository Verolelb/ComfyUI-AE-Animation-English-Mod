import torch
import json
import base64
import io as python_io
import math
from PIL import Image
import numpy as np
import cv2

class AERender:
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "animation": ("STRING", {"forceInput": True}),
                "start_frame": ("INT", {"default": 0, "min": 0}),
                "end_frame": ("INT", {"default": -1, "min": -1}),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "MASK",) 
    RETURN_NAMES = ("frames", "mask_frames",)
    FUNCTION = "render"
    CATEGORY = "AE Animation"
    
    def _get_value(self, kf, prop, time, default):
        if prop not in kf:
            return default
        
        keyframes = kf[prop]
        if not keyframes:
            return default
        
        keyframes = sorted(keyframes, key=lambda k: k.get("time", 0))
        
        if time <= keyframes[0]["time"]:
            return keyframes[0]["value"]
        if time >= keyframes[-1]["time"]:
            return keyframes[-1]["value"]
        
        for i in range(len(keyframes) - 1):
            k1 = keyframes[i]
            k2 = keyframes[i + 1]
            if k1["time"] <= time <= k2["time"]:
                duration = k2["time"] - k1["time"]
                t = (time - k1["time"]) / duration if duration > 0 else 0
                return k1["value"] + (k2["value"] - k1["value"]) * t
        
        return default

    def render(self, animation, start_frame, end_frame):
        try:
            config = json.loads(animation)
            project = config["project"]
            layers = config.get("layers", [])
        except Exception as e:
            return (torch.zeros((1, 64, 64, 3)), torch.zeros((1, 64, 64)))
        
        width = project["width"]
        height = project["height"]
        fps = project["fps"]
        total_frames = project["total_frames"]
        duration = project.get("duration", 5.0)
        
        mask_expansion = project.get("mask_expansion", 0)
        mask_feather = project.get("mask_feather", 0)
        
        if end_frame == -1:
            end_frame = total_frames
        
        images_info = []
        for layer in layers:
            try:
                img_b64 = layer['image_data'].split(',')[1]
                img_data = base64.b64decode(img_b64)
                img = Image.open(python_io.BytesIO(img_data)).convert("RGBA")
                
                layer_type = "background" if layer.get("type") == "background" else "foreground"
                bg_mode = layer.get("bg_mode", "fit")
                custom_mask = layer.get("customMask")
                
                print(f"[AERender] Layer {layer.get('id')}: type={layer_type}, bg_mode={bg_mode}, has_customMask={bool(custom_mask)}, size={img.width}x{img.height}")
                
                images_info.append({
                    "data": np.array(img), 
                    "keyframes": layer.get("keyframes", {}),
                    "type": layer_type,
                    "orig_w": img.width,
                    "orig_h": img.height,
                    "bg_mode": bg_mode,
                    "customMask": custom_mask,
                    "bezierPath": layer.get("bezierPath")
                })
            except Exception as e:
                print(f"[AERender] Layer decode error: {e}")
                continue
        
        if not images_info:
            return (torch.zeros((1, 64, 64, 3)), torch.zeros((1, 64, 64)))
        
        frames = []
        mask_frames = []
        
        for frame_idx in range(start_frame, min(end_frame, total_frames)):
            time = frame_idx / fps
            
            # --- Canvas Initialization (Strictly adheres to project width/height) ---
            canvas = np.zeros((height, width, 4), dtype=np.uint8)
            mask_canvas = np.zeros((height, width, 1), dtype=np.uint8) 
            
            for img_info in images_info:
                img_np = img_info["data"].copy()
                kf = img_info["keyframes"]
                is_foreground = img_info["type"] == "foreground"
                
                x = self._get_value(kf, "x", time, 0)
                y = self._get_value(kf, "y", time, 0)
                
                # ✨ 修改：如果有贝塞尔路径，根据时间计算位置
                bezier_path = img_info.get("bezierPath")
                if bezier_path:
                    path_duration = duration
                    if time <= path_duration:
                        t = time / path_duration  # 归一化时间 0-1
                        path = bezier_path
                        # 三次贝塞尔曲线公式
                        # B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
                        p0 = path["p0"]
                        p1 = path["p1"]
                        p2 = path["p2"]
                        p3 = path["p3"]
                        
                        t2 = t * t
                        t3 = t2 * t
                        mt = 1 - t
                        mt2 = mt * mt
                        mt3 = mt2 * mt
                        
                        # 计算贝塞尔曲线上的点
                        bx = mt3 * p0["x"] + 3 * mt2 * t * p1["x"] + 3 * mt * t2 * p2["x"] + t3 * p3["x"]
                        by = mt3 * p0["y"] + 3 * mt2 * t * p1["y"] + 3 * mt * t2 * p2["y"] + t3 * p3["y"]
                        
                        # 转换为相对于中心的坐标
                        x = bx - width / 2
                        y = by - height / 2
                
                scale = self._get_value(kf, "scale", time, 1.0)
                opacity = self._get_value(kf, "opacity", time, 1.0)
                rotation = self._get_value(kf, "rotation", time, 0)
                mask_size = self._get_value(kf, "mask_size", time, 1.0) 
                bg_mode = img_info["bg_mode"]

                # 1. Scaling Logic
                new_w, new_h = img_np.shape[1], img_np.shape[0]
                
                if not is_foreground:
                    # Background: calculate base scale from mode (match frontend)
                    orig_w, orig_h = img_np.shape[1], img_np.shape[0]
                    
                    # Calculate base scale based on mode
                    if bg_mode == "fit":
                        base_scale = min(width / orig_w, height / orig_h)
                    elif bg_mode == "fill":
                        base_scale = max(width / orig_w, height / orig_h)
                    else:  # stretch or default
                        base_scale = 1.0
                    
                    # Apply final scale = base_scale * user_scale
                    final_scale = base_scale * scale
                    
                    # Resize based on mode
                    if bg_mode == "stretch":
                        # Stretch: first resize to canvas, then apply user scale
                        new_w = max(1, int(width * scale))
                        new_h = max(1, int(height * scale))
                    else:
                        # Fit/Fill: resize by combined scale
                        new_w = max(1, int(orig_w * final_scale))
                        new_h = max(1, int(orig_h * final_scale))
                    
                    print(f"[AERender] BG: mode={bg_mode}, orig={orig_w}x{orig_h}, canvas={width}x{height}, base_scale={base_scale:.3f}, user_scale={scale:.3f}, final={new_w}x{new_h}")
                else:
                    # Foreground: simple scaling
                    if scale != 1.0 and scale > 0:
                        new_w = max(1, int(img_np.shape[1] * scale))
                        new_h = max(1, int(img_np.shape[0] * scale))

                if new_w != img_np.shape[1] or new_h != img_np.shape[0]:
                    img_np = cv2.resize(img_np, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
                
                current_w = img_np.shape[1]
                current_h = img_np.shape[0]

                # 2. Rotation
                M_rot = None
                if abs(rotation) > 0.1:
                    center = (current_w // 2, current_h // 2)
                    M_rot = cv2.getRotationMatrix2D(center, rotation, 1.0)
                    img_np = cv2.warpAffine(img_np, M_rot, (current_w, current_h), 
                                           borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))

                # 3. Position Calculation
                paste_y = int(height // 2 + y - current_h // 2)
                paste_x = int(width // 2 + x - current_w // 2)

                # 4. Mask Generation (Foreground Layers Only)
                if is_foreground: 
                    # Use the alpha channel of the foreground image as mask
                    if img_np.shape[2] == 4:
                        # Extract alpha channel and apply opacity
                        mask_layer_np = (img_np[:, :, 3].astype(np.float32) * opacity).astype(np.uint8)
                    else:
                        # If no alpha channel, create full white mask with opacity
                        mask_layer_np = np.full((current_h, current_w), int(255 * opacity), dtype=np.uint8)
                    
                    # Apply user-drawn mask if exists
                    if img_info.get("customMask"):
                        try:
                            print(f"[AERender] Applying custom mask: x={x:.1f}, y={y:.1f}, scale={scale:.3f}, rot={rotation:.1f}, layer_size={current_w}x{current_h}")
                            
                            # Decode mask from base64
                            custom_mask_b64 = img_info["customMask"].split(',')[1]
                            custom_mask_data = base64.b64decode(custom_mask_b64)
                            custom_mask_img = Image.open(python_io.BytesIO(custom_mask_data)).convert("L")
                            custom_mask_np = np.array(custom_mask_img)
                            
                            print(f"[AERender] Custom mask decoded: {custom_mask_np.shape}, non-zero pixels: {np.count_nonzero(custom_mask_np)}")
                            
                            # Resize custom mask to match output canvas size
                            if custom_mask_np.shape != (height, width):
                                custom_mask_np = cv2.resize(custom_mask_np, (width, height), interpolation=cv2.INTER_LINEAR)
                            
                            # Extract the region from canvas mask corresponding to layer position
                            # Use affine transform to handle rotation and scale
                            center_x, center_y = width / 2, height / 2
                            
                            # Build inverse transform matrix (from layer space to canvas space)
                            # First translate to layer position
                            layer_center_canvas_x = center_x + x
                            layer_center_canvas_y = center_y + y
                            
                            # Rotation matrix (inverse)
                            angle_rad = -rotation * math.pi / 180
                            cos_a = math.cos(angle_rad)
                            sin_a = math.sin(angle_rad)
                            
                            # Affine matrix: translate to layer center, rotate (inverse), scale (inverse)
                            M = np.array([
                                [cos_a / scale, -sin_a / scale, layer_center_canvas_x - (cos_a / scale) * current_w / 2 + (sin_a / scale) * current_h / 2],
                                [sin_a / scale, cos_a / scale, layer_center_canvas_y - (sin_a / scale) * current_w / 2 - (cos_a / scale) * current_h / 2]
                            ], dtype=np.float32)
                            
                            # Apply inverse warp to extract mask region
                            layer_mask_transformed = cv2.warpAffine(
                                custom_mask_np, M, (current_w, current_h),
                                flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0
                            )
                            
                            print(f"[AERender] Mask transformed: non-zero pixels after transform: {np.count_nonzero(layer_mask_transformed)}")
                            
                            # Multiply with existing alpha mask
                            mask_layer_np = (mask_layer_np.astype(np.float32) * 
                                           (layer_mask_transformed.astype(np.float32) / 255.0)).astype(np.uint8)
                            
                            print(f"[AERender] Final mask after multiplication: non-zero pixels: {np.count_nonzero(mask_layer_np)}")
                        except Exception as e:
                            print(f"[AERender] Custom mask application error: {e}")
                            import traceback
                            traceback.print_exc()
                            pass  # If custom mask fails, use original alpha mask

                    # Compositing Mask onto Mask Canvas (OR operation)
                    m_y_start_canvas = max(0, paste_y)
                    m_x_start_canvas = max(0, paste_x)
                    m_y_end_canvas = min(paste_y + mask_layer_np.shape[0], height)
                    m_x_end_canvas = min(paste_x + mask_layer_np.shape[1], width)
                    
                    m_layer_y_start = max(0, -paste_y)
                    m_layer_x_start = max(0, -paste_x)
                    m_layer_y_end = m_layer_y_start + (m_y_end_canvas - m_y_start_canvas)
                    m_layer_x_end = m_layer_x_start + (m_x_end_canvas - m_x_start_canvas)

                    if m_y_end_canvas > m_y_start_canvas and m_x_end_canvas > m_x_start_canvas:
                        src_mask_region = mask_layer_np[m_layer_y_start:m_layer_y_end, m_layer_x_start:m_layer_x_end]
                        dst_mask_region = mask_canvas[m_y_start_canvas:m_y_end_canvas, m_x_start_canvas:m_x_end_canvas, 0]
                        
                        mask_canvas[m_y_start_canvas:m_y_end_canvas, m_x_start_canvas:m_x_end_canvas, 0] = np.maximum(dst_mask_region, src_mask_region)

                # 5. Image Compositing (same as before)
                if paste_y < height and paste_x < width and paste_y + current_h > 0 and paste_x + current_w > 0:
                    y_start = max(0, paste_y)
                    x_start = max(0, paste_x)
                    y_end = min(paste_y + current_h, height)
                    x_end = min(paste_x + current_w, width)
                    
                    img_y_start = max(0, -paste_y)
                    img_x_start = max(0, -paste_x)
                    img_y_end = img_y_start + (y_end - y_start)
                    img_x_end = img_x_start + (x_end - x_start)
                    
                    if y_end > y_start and x_end > x_start:
                        src_region = img_np[img_y_start:img_y_end, img_x_start:img_x_end]
                        dst_region = canvas[y_start:y_end, x_start:x_end]
                        
                        if src_region.shape[2] == 4:
                            alpha = (src_region[:, :, 3:4].astype(np.float32) / 255.0) * opacity
                            
                            for c in range(3):
                                dst_region[:, :, c] = (
                                    dst_region[:, :, c].astype(np.float32) * (1 - alpha[:, :, 0]) +
                                    src_region[:, :, c].astype(np.float32) * alpha[:, :, 0]
                                ).astype(np.uint8)
                            
                            dst_region[:, :, 3] = np.maximum(dst_region[:, :, 3], (alpha[:, :, 0] * 255).astype(np.uint8))
                        
                        canvas[y_start:y_end, x_start:x_end] = dst_region


            # 6. Mask Post-processing (Expansion/Feathering)
            final_mask_np = mask_canvas[:, :, 0].copy()
            
            # Mask Expansion/Erosion (Using 3x3 kernel for accurate pixel expansion)
            if mask_expansion != 0:
                kernel = np.ones((3, 3), np.uint8)
                # Use absolute value of expansion as iteration count for pixel-accurate expansion
                iterations = abs(mask_expansion)
                
                if mask_expansion > 0: 
                    final_mask_np = cv2.dilate(final_mask_np, kernel, iterations=iterations)
                else: 
                    final_mask_np = cv2.erode(final_mask_np, kernel, iterations=iterations)
            
            # Mask Feathering/Blur
            if mask_feather > 0:
                ksize = max(3, mask_feather * 2 + 1) 
                final_mask_np = cv2.GaussianBlur(final_mask_np, (ksize, ksize), 0)

            # 7. Finalize Frame and Mask
            
            frame_rgb = canvas[:, :, :3]
            frame_tensor = torch.from_numpy(frame_rgb).float() / 255.0
            frames.append(frame_tensor)
            
            # Output Mask: (H, W) shape and 0.0-1.0 range (ComfyUI standard)
            mask_tensor = torch.from_numpy(final_mask_np).float() / 255.0
            mask_frames.append(mask_tensor)
        
        if not frames:
            return (torch.zeros((1, 64, 64, 3)), torch.zeros((1, 64, 64)))
        
        return (torch.stack(frames), torch.stack(mask_frames))