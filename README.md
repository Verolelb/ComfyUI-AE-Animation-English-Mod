# ComfyUI-AE-Animation (English & Enhanced Mod)

This is a fork/modified version of [wallen0322/ComfyUI-AE-Animation](https://github.com/wallen0322/ComfyUI-AE-Animation).

## ✨ Why use this version?
While the original node is powerful, this version adds specific features for better control:

1.  **🇬🇧 English Translation**: The entire UI, logs, and tooltips have been translated from Chinese to English.
2.  **↔️ Mirror/Flip**: Added **Flip H** (Horizontal) and **Flip V** (Vertical) checkboxes. You can now animate flipping!
3.  **📐 Independent Scaling**: The "Scale" property has been split into **Scale X** and **Scale Y**. You can now stretch or squash images independently on width and height.

## Original Features (v1.1.0)
*   **Timeline Editor**: Visual keyframe editing.
*   **Multi-layer**: Background + multiple foregrounds.
*   **Mask Editor**: Brush with jitter edges.
*   **Background Extraction**: Extract subjects and auto-fill backgrounds.
*   **Performance**: Image compression, lazy loading.
*   **Import**: Directly import images from your computer into the timeline.

## Installation

1.  Navigate to your ComfyUI custom nodes directory:
    ```bash
    cd ComfyUI/custom_nodes/
    ```
2.  Clone this repository:
    ```bash
    git clone https://github.com/Verolelb/ComfyUI-AE-Animation-English-Mod.git
    ```
3.  Restart ComfyUI.

## Usage Tips regarding new features
*   **Flip H/V**: Look for the checkboxes in the properties panel when a layer is selected.
*   **Scale X/Y**: Instead of a single "Scale" slider, you now have control over Width (X) and Height (Y) separately.
*   **Backwards Compatibility**: Projects made with the original node should load, but you might need to re-adjust scaling if the original used a single scale value.

## Credits & License
*   Original Author: [wallen0322](https://github.com/wallen0322)
*   License: MIT
