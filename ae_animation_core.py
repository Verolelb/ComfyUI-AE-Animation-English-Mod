from __future__ import annotations

import base64
import io as python_io
import json
import logging
from typing import Any, Dict, List, Optional, Sequence

import cv2
import numpy as np
import torch
from PIL import Image
from comfy_api.latest import ComfyExtension, io
from server import PromptServer
from typing_extensions import override


def _tensor_to_b64(img_tensor: torch.Tensor) -> str | None:
    try:
        tensor = img_tensor.float().cpu()
        if tensor.dtype != torch.uint8:
            tensor = torch.clamp(tensor, 0, 1) * 255.0
        
        # Handle batch dimension: if 4D [B, H, W, C], take first image
        if tensor.ndim == 4:
            array = tensor[0].numpy().astype("uint8")
        else:
            array = tensor.numpy().astype("uint8")
        
        mode_map = {4: "RGBA", 3: "RGB", 2: "L"}
        if array.ndim == 3:
            mode = mode_map.get(array.shape[2])
            if not mode:
                return None
            img = Image.fromarray(array, mode)
        elif array.ndim == 2:
            img = Image.fromarray(array, "L").convert("RGB")
        else:
            return None
        buffer = python_io.BytesIO()
        img.save(buffer, format="PNG")
        payload = base64.b64encode(buffer.getvalue()).decode("utf-8")
        return f"data:image/png;base64,{payload}"
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[AE] tensor_to_b64 error: {exc}")
        return None


def _ensure_list(obj: Any) -> List[Any]:
    if obj is None:
        return []
    if isinstance(obj, (list, tuple)):
        return list(obj)
    return [obj]


class AEAnimationCore(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        supports_bool = hasattr(io, "Bool")
        preview_input = (
            io.Bool.Input("ui_preview_only", default=False, optional=True)
            if supports_bool
            else io.Int.Input("ui_preview_only", default=0, min=0, max=1, optional=True)
        )

        schema = io.Schema(
            node_id="AEAnimationCore",
            display_name="AE Animation Core",
            category="AE Animation",
            inputs=[
                io.Int.Input("width", default=1280, min=64, max=8192),
                io.Int.Input("height", default=720, min=64, max=8192),
                io.Int.Input("fps", default=16, min=1, max=120),
                io.Int.Input("total_frames", default=81, min=1, max=9999),
                io.Int.Input("mask_expansion", default=0, min=-255, max=255),
                io.Int.Input("mask_feather", default=0, min=0, max=100),
                io.String.Input("layers_keyframes", default="[]", multiline=True),
                
                # 5 Optional Image Inputs
                io.Image.Input("image_1", optional=True),
                io.Image.Input("image_2", optional=True),
                io.Image.Input("image_3", optional=True),
                io.Image.Input("image_4", optional=True),
                io.Image.Input("image_5", optional=True),
                
                io.Image.Input("background_image", optional=True),
                preview_input,
                io.String.Input("unique_id", default="", optional=True),
            ],
            outputs=[
                io.String.Output("animation"),
                io.String.Output("animation_preview"),
            ],
        )
        schema.output_node = True
        return schema

    @classmethod
    def _safe_int(cls, value: Any, default: int = 0) -> int:
        try:
            if isinstance(value, str) and value.strip():
                return int(value)
            if value is None:
                return default
            return int(value)
        except (ValueError, TypeError):
            return default

    @classmethod
    def _build_layer(cls, layer_id: str, layer_name: str, layer_type: str,
                     image_b64: str, saved_data: Dict[str, Any]) -> Dict[str, Any]:
        layer: Dict[str, Any] = {
            "id": layer_id,
            "name": layer_name,
            "type": layer_type,
            "image_data": image_b64,
            "keyframes": saved_data.get("keyframes", {}),
        }
        
        # Common props
        common_props = ["x", "y", "scale", "scale_x", "scale_y", "rotation", "flip_h", "flip_v"]
        
        if layer_type == "background":
            layer["bg_mode"] = saved_data.get("bg_mode", "fit")
            for prop in common_props:
                if prop in saved_data:
                    layer[prop] = saved_data[prop]
        else:
            # Foreground specific properties + common transforms
            for prop in common_props:
                if prop in saved_data:
                    layer[prop] = saved_data[prop]
            
            if "opacity" in saved_data:
                layer["opacity"] = saved_data["opacity"]
            if "mask_size" in saved_data:
                layer["mask_size"] = saved_data["mask_size"]
            if saved_data.get("customMask"):
                layer["customMask"] = saved_data["customMask"]
            if saved_data.get("bezierPath"):
                layer["bezierPath"] = saved_data["bezierPath"]
                
        # Preserve cached image if exists
        if saved_data.get("image_data"):
            layer["image_data"] = saved_data["image_data"]
        return layer

    @classmethod
    def execute(
        cls,
        width: int,
        height: int,
        fps: int,
        total_frames: int,
        mask_expansion: int,
        mask_feather: int,
        layers_keyframes: str,
        # 5 Discrete inputs
        image_1: Optional[torch.Tensor] = None,
        image_2: Optional[torch.Tensor] = None,
        image_3: Optional[torch.Tensor] = None,
        image_4: Optional[torch.Tensor] = None,
        image_5: Optional[torch.Tensor] = None,
        background_image: Optional[torch.Tensor] = None,
        ui_preview_only: Any = False,
        unique_id: Optional[str] = None,
    ) -> io.NodeOutput:
        # Calculate duration from total_frames and fps
        duration = total_frames / max(fps, 1)

        project_data = {
            "width": width,
            "height": height,
            "fps": fps,
            "duration": duration,
            "total_frames": total_frames,
            "mask_expansion": mask_expansion,
            "mask_feather": mask_feather,
        }

        try:
            saved_keyframes = json.loads(layers_keyframes) if layers_keyframes else []
        except json.JSONDecodeError:
            saved_keyframes = []

        layers: List[Dict[str, Any]] = []
        
        # Process background image
        if background_image is not None:
            bg_b64 = _tensor_to_b64(background_image)
            if bg_b64:
                existing = next((k for k in saved_keyframes if k.get("id") == "background"), {})
                layers.append(cls._build_layer("background", "Background", "background", bg_b64, existing))
        else:
            # Try to restore from cached data
            existing = next((k for k in saved_keyframes if k.get("id") == "background" and k.get("image_data")), None)
            if existing:
                if "name" not in existing:
                    existing["name"] = "Background"
                if "type" not in existing:
                    existing["type"] = "background"
                layers.append(existing)

        # Process foreground images (1 to 5)
        processed_ids = set()
        
        # Put inputs in a list to iterate
        input_images = [image_1, image_2, image_3, image_4, image_5]
        
        current_layer_index = 0
        
        for input_idx, tensor in enumerate(input_images):
            if tensor is None:
                continue
                
            # Even within one input (e.g., image_1), it could be a batch of images
            # Handle batch dimension: if 4D [B, H, W, C], split into list
            if isinstance(tensor, torch.Tensor) and tensor.ndim == 4:
                batch_tensors = [tensor[i:i+1] for i in range(tensor.shape[0])]
            else:
                batch_tensors = _ensure_list(tensor)
            
            for b_idx, single_tensor in enumerate(batch_tensors):
                if single_tensor is None: 
                    continue
                fg_b64 = _tensor_to_b64(single_tensor)
                if not fg_b64:
                    continue
                
                # Create a unique ID. Logic: layer_0, layer_1, etc.
                layer_id = f"layer_{current_layer_index}"
                processed_ids.add(layer_id)
                
                # Name it nicely: "Image 1", "Image 2 (Batch 2)", etc.
                if len(batch_tensors) > 1:
                    name = f"Image {input_idx+1} (Batch {b_idx+1})"
                else:
                    name = f"Image {input_idx+1}"

                existing = next((k for k in saved_keyframes if k.get("id") == layer_id), {})
                layers.append(cls._build_layer(layer_id, name, "foreground", fg_b64, existing))
                
                current_layer_index += 1
        
        # Add any additional foreground layers from saved_keyframes (e.g., extracted layers)
        extracted_count = 0
        for saved_layer in saved_keyframes:
            if (saved_layer.get("type") == "foreground" and 
                saved_layer.get("image_data") and 
                saved_layer.get("id") not in processed_ids):
                layers.append(saved_layer)
                if saved_layer.get("id", "").startswith("extracted_"):
                    extracted_count += 1
        
        if extracted_count > 0:
            print(f"[AE] Added {extracted_count} extracted layer(s)")

        final_animation = {"project": project_data, "layers": layers}
        print(f"[AE] Final animation: {len(layers)} total layers")
        
        # Send WebSocket update
        if unique_id and layers:
            try:
                from server import PromptServer
                PromptServer.instance.send_sync("ae_animation_update", {
                    "node_id": str(unique_id),
                    "animation": final_animation
                })
            except Exception as e:
                print(f"[AE] WebSocket error: {e}")

        result_json = json.dumps(final_animation)

        preview_enabled = cls._to_bool(ui_preview_only)

        outputs: List[Any] = [result_json]
        if preview_enabled:
            outputs.append(result_json)
        else:
            outputs.append(None)

        return io.NodeOutput(*outputs)

    @staticmethod
    def _to_bool(value: Any) -> bool:
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        if isinstance(value, (int, float)):
            return bool(value)
        return bool(value)


class AERender(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AERender",
            display_name="AE Render",
            category="AE Animation",
            inputs=[
                io.String.Input("animation", multiline=True),
                io.Int.Input("start_frame", default=0, min=0),
                io.Int.Input("end_frame", default=-1, min=-1),
            ],
            outputs=[
                io.Image.Output("frames"),
                io.Mask.Output("mask_frames"),
            ],
        )

    @classmethod
    def _get_value(cls, keyframes: Dict[str, Any], prop: str, time: float, default: float) -> float:
        if prop not in keyframes:
            return default
            
        frames_data = keyframes[prop]
        if not isinstance(frames_data, list):
            logging.warning(f"Invalid keyframe data type for property '{prop}': expected list, got {type(frames_data).__name__}")
            return default
            
        frames = []
        invalid_count = 0
        for frame in frames_data:
            if isinstance(frame, dict) and 'time' in frame and 'value' in frame:
                frames.append(frame)
            else:
                invalid_count += 1
                
        if invalid_count > 0:
            logging.warning(f"Skipped {invalid_count} invalid frame(s) in property '{prop}' (missing 'time' or 'value')")
                
        if not frames:
            logging.warning(f"No valid frames found for property '{prop}', using default value {default}")
            return default
            
        frames.sort(key=lambda k: k["time"])
        if time <= frames[0]["time"]:
            return frames[0]["value"]
        if time >= frames[-1]["time"]:
            return frames[-1]["value"]
        for idx in range(len(frames) - 1):
            k1, k2 = frames[idx], frames[idx + 1]
            if k1["time"] <= time <= k2["time"]:
                duration = k2["time"] - k1["time"]
                t = (time - k1["time"]) / duration if duration > 0 else 0
                return k1["value"] + (k2["value"] - k1["value"]) * t
        return default

    @classmethod
    def execute(cls, animation: str, start_frame: int, end_frame: int) -> io.NodeOutput:
        import math
        try:
            config = json.loads(animation)
        except json.JSONDecodeError:
            zeros = torch.zeros((1, 64, 64, 3))
            mask = torch.zeros((1, 64, 64))
            return io.NodeOutput(zeros, mask)

        project = config.get("project", {})
        layers_data = config.get("layers", [])
        width = project.get("width", 512)
        height = project.get("height", 512)
        fps = project.get("fps", 30)
        total_frames = project.get("total_frames", max(1, int(project.get("duration", 1) * fps)))
        duration = project.get("duration", total_frames / max(fps, 1))
        mask_expansion = project.get("mask_expansion", 0)
        mask_feather = project.get("mask_feather", 0)
        
        num_layers = len(layers_data)
        print(f"[AE] Render: {width}x{height}, {start_frame}-{end_frame}/{total_frames}, {num_layers} layers")
        
        layers = []
        for layer in layers_data:
            try:
                img_b64 = layer['image_data'].split(',')[1]
                img_data = base64.b64decode(img_b64)
                img = Image.open(python_io.BytesIO(img_data)).convert("RGBA")
                
                layer_type = "background" if layer.get("type") == "background" else "foreground"
                bg_mode = layer.get("bg_mode", "fit")
                custom_mask = layer.get("customMask")
                
                layers.append({
                    "data": np.array(img),
                    "keyframes": layer.get("keyframes", {}),
                    "type": layer_type,
                    "orig_w": img.width,
                    "orig_h": img.height,
                    "bg_mode": bg_mode,
                    "customMask": custom_mask,
                    "x": layer.get("x", 0),
                    "y": layer.get("y", 0),
                    "scale": layer.get("scale", 1.0), 
                    "scale_x": layer.get("scale_x", 1.0),
                    "scale_y": layer.get("scale_y", 1.0),
                    "rotation": layer.get("rotation", 0),
                    "opacity": layer.get("opacity", 1.0),
                    "flip_h": layer.get("flip_h", 0), 
                    "flip_v": layer.get("flip_v", 0),
                })
            except Exception as e:
                print(f"[AE] Layer decode error: {e}")
                continue

        if end_frame == -1 or end_frame > total_frames:
            end_frame = total_frames

        frames: List[torch.Tensor] = []
        masks: List[torch.Tensor] = []

        for frame_idx in range(start_frame, end_frame):
            time = frame_idx / max(fps, 1)
            canvas = np.zeros((height, width, 4), dtype=np.uint8)
            mask_canvas = np.zeros((height, width), dtype=np.uint8)

            for layer in layers:
                img_np = layer["data"].copy()
                kf = layer.get("keyframes", {})
                is_foreground = layer.get("type") == "foreground"

                x = cls._get_value(kf, "x", time, layer.get("x", 0))
                y = cls._get_value(kf, "y", time, layer.get("y", 0))
                
                base_scale = cls._get_value(kf, "scale", time, layer.get("scale", 1.0))
                scale_x = cls._get_value(kf, "scale_x", time, layer.get("scale_x", 1.0))
                scale_y = cls._get_value(kf, "scale_y", time, layer.get("scale_y", 1.0))
                
                final_scale_x = base_scale * scale_x
                final_scale_y = base_scale * scale_y

                rotation = cls._get_value(kf, "rotation", time, layer.get("rotation", 0))
                opacity = cls._get_value(kf, "opacity", time, layer.get("opacity", 1.0))
                
                flip_h = cls._get_value(kf, "flip_h", time, layer.get("flip_h", 0))
                flip_v = cls._get_value(kf, "flip_v", time, layer.get("flip_v", 0))

                bg_mode = layer.get("bg_mode", "fit")

                if is_foreground and layer.get("customMask"):
                    try:
                        custom_mask_b64 = layer["customMask"].split(',')[1]
                        custom_mask_data = base64.b64decode(custom_mask_b64)
                        custom_mask_img = Image.open(python_io.BytesIO(custom_mask_data)).convert("L")
                        custom_mask_np = np.array(custom_mask_img)
                        
                        orig_h, orig_w = img_np.shape[:2]
                        if custom_mask_np.shape != (orig_h, orig_w):
                            custom_mask_np = cv2.resize(custom_mask_np, (orig_w, orig_h), interpolation=cv2.INTER_LINEAR)
                        
                        if img_np.shape[2] == 4:
                            img_np[:, :, 3] = (
                                img_np[:, :, 3].astype(np.float32) * 
                                (custom_mask_np.astype(np.float32) / 255.0)
                            ).astype(np.uint8)
                    except Exception as e:
                        print(f"[AERender] Custom mask error: {e}")

                new_w, new_h = img_np.shape[1], img_np.shape[0]
                
                if not is_foreground:
                    orig_w, orig_h = img_np.shape[1], img_np.shape[0]
                    if bg_mode == "fit":
                        mode_scale = min(width / orig_w, height / orig_h)
                        final_w = int(orig_w * mode_scale * final_scale_x)
                        final_h = int(orig_h * mode_scale * final_scale_y)
                    elif bg_mode == "fill":
                        mode_scale = max(width / orig_w, height / orig_h)
                        final_w = int(orig_w * mode_scale * final_scale_x)
                        final_h = int(orig_h * mode_scale * final_scale_y)
                    else:
                        final_w = int(width * final_scale_x)
                        final_h = int(height * final_scale_y)
                        
                    new_w = max(1, final_w)
                    new_h = max(1, final_h)
                else:
                    if final_scale_x != 1.0 or final_scale_y != 1.0:
                        new_w = max(1, int(img_np.shape[1] * final_scale_x))
                        new_h = max(1, int(img_np.shape[0] * final_scale_y))

                if new_w != img_np.shape[1] or new_h != img_np.shape[0]:
                    img_np = cv2.resize(img_np, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
                
                do_flip_h = flip_h > 0.5
                do_flip_v = flip_v > 0.5
                
                if do_flip_h and do_flip_v:
                    img_np = cv2.flip(img_np, -1)
                elif do_flip_h:
                    img_np = cv2.flip(img_np, 1)
                elif do_flip_v:
                    img_np = cv2.flip(img_np, 0)

                current_w, current_h = img_np.shape[1], img_np.shape[0]

                if abs(rotation) > 0.1:
                    center = (current_w // 2, current_h // 2)
                    matrix = cv2.getRotationMatrix2D(center, rotation, 1.0)
                    img_np = cv2.warpAffine(img_np, matrix, (current_w, current_h), borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))

                paste_x = int(width // 2 + x - current_w // 2)
                paste_y = int(height // 2 + y - current_h // 2)
                
                if is_foreground:
                    if img_np.shape[2] == 4:
                        mask_layer_np = (img_np[:, :, 3].astype(np.float32) * opacity).astype(np.uint8)
                    else:
                        mask_layer_np = np.full((current_h, current_w), int(255 * opacity), dtype=np.uint8)
                    
                    m_y_start = max(0, paste_y)
                    m_x_start = max(0, paste_x)
                    m_y_end = min(paste_y + current_h, height)
                    m_x_end = min(paste_x + current_w, width)
                    if m_y_end > m_y_start and m_x_end > m_x_start:
                        layer_y_offset = max(0, -paste_y)
                        layer_x_offset = max(0, -paste_x)
                        src_mask = mask_layer_np[layer_y_offset:layer_y_offset + (m_y_end - m_y_start), layer_x_offset:layer_x_offset + (m_x_end - m_x_start)]
                        mask_canvas[m_y_start:m_y_end, m_x_start:m_x_end] = np.maximum(mask_canvas[m_y_start:m_y_end, m_x_start:m_x_end], src_mask)

                y_start = max(0, paste_y)
                x_start = max(0, paste_x)
                y_end = min(paste_y + current_h, height)
                x_end = min(paste_x + current_w, width)
                if y_end > y_start and x_end > x_start:
                    src_y = max(0, -paste_y)
                    src_x = max(0, -paste_x)
                    src_region = img_np[src_y:src_y + (y_end - y_start), src_x:src_x + (x_end - x_start)]
                    dst_region = canvas[y_start:y_end, x_start:x_end]
                    alpha = (src_region[:, :, 3:4].astype(np.float32) / 255.0) * opacity if src_region.shape[2] == 4 else np.full((src_region.shape[0], src_region.shape[1], 1), opacity, dtype=np.float32)
                    for c in range(3):
                        dst_region[:, :, c] = (dst_region[:, :, c].astype(np.float32) * (1 - alpha[:, :, 0]) + src_region[:, :, c].astype(np.float32) * alpha[:, :, 0]).astype(np.uint8)
                    dst_region[:, :, 3] = np.maximum(dst_region[:, :, 3], (alpha[:, :, 0] * 255).astype(np.uint8))
                    canvas[y_start:y_end, x_start:x_end] = dst_region

            if mask_expansion != 0:
                kernel = np.ones((3, 3), np.uint8)
                if mask_expansion > 0:
                    mask_canvas = cv2.dilate(mask_canvas, kernel, iterations=abs(mask_expansion))
                else:
                    mask_canvas = cv2.erode(mask_canvas, kernel, iterations=abs(mask_expansion))
            if mask_feather > 0:
                ksize = max(3, mask_feather * 2 + 1)
                mask_canvas = cv2.GaussianBlur(mask_canvas, (ksize, ksize), 0)

            frame_rgb = canvas[:, :, :3].astype(np.float32) / 255.0
            frames.append(torch.from_numpy(frame_rgb))
            masks.append(torch.from_numpy(mask_canvas.astype(np.float32) / 255.0))

        if not frames:
            return io.NodeOutput(torch.zeros((1, 64, 64, 3)), torch.zeros((1, 64, 64)))

        frames_tensor = torch.stack(frames)
        masks_tensor = torch.stack(masks)
        return io.NodeOutput(frames_tensor, masks_tensor)


class AEAnimationExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> List[type[io.ComfyNode]]:
        return [AEAnimationCore, AERender]


async def comfy_entrypoint() -> AEAnimationExtension:
    return AEAnimationExtension()