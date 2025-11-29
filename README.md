This is a fork of ComfyUI-AE-Animation by wallen0322. Translated to English and added Mirror/Independent Scaling features."

# ComfyUI-AE-Animation

ComfyUI's After Effects-style animation timeline nodes, supporting keyframe animation, layer management, mask editing, and background extraction.

## Features

### 🎬 Core Functions

- **Timeline Editor**: Visual keyframe animation editing

- **Multi-Layer Management**: Background layer + multiple foreground layers

- **Keyframe Animation**: Position, scaling, rotation, and transparency animation

- **Real-time Preview**: Canvas real-time rendering preview

### 🎨 Advanced Functions

- **Mask Brush**: Customizable layer transparency masking, supports jittery edge effects

- **Bezier Path**: Path animation and motion trajectory

- **Background Extraction**: Brush strokes extract background areas, automatically blurring the background and creating a new foreground layer

- **Layer Sorting**: Move up/down/top/bottom

- **Local Image Import**: Directly import local images as new layers within the UI, automatically compressed and optimized

- **Single Node Preview**: Preview animations independently without running the entire workflow

- **UI Parameter Control**: Resolution, FPS, and total frames can be adjusted uniformly within the UI

### 🖼️ Background Modes

- **Fit**: Maintain aspect ratio, display fully

- **Fill**: Maintain aspect ratio, fill the canvas

- **Stretch**: Stretch the fill

## Installation

```bash
cd ComfyUI/custom_nodes

git clone https://github.com/wallen0322/ComfyUI-AE-Animation.git

# Restart ComfyUI

```

## Usage

### Basic Workflow

```
LoadImage (background) → AEAnimationCore.background_image

LoadImage (foreground) → AEAnimationCore.foreground_images (optional, supports batch processing)

AEAnimationCore.animation → AERender.animation

AERender.frames → PreviewImage / SaveImage

AERender.mask_frames → Output Mask channel

```

### AEAnimationCore Node

**Input**:

- `width`, `height`: Project size (default 1280x720, recommended to adjust in the UI)

- `fps`: Frame rate (default 16, recommended to adjust in the UI)

- `total_frames`: Total frames (default 81, recommended to adjust in the UI)

- `mask_expansion`: Mask expansion/shrinkage (-10 to 10)

- `mask_feather`: Mask feathering (0 to 20)

- `background_image`: Background image (optional)

- `foreground_images`: Foreground images (optional, supports batch input)

- `ui_preview_only`: When set to True, only preview data is output

**Output**:

- `animation`: Animation data (JSON string)

### AERender Node

**Input**:

- `animation`: Animation data from AEEAnimationCore

- `start_frame`: Start frame (default 0)

- `end_frame`: End frame (-1 indicates all frames)

**Output**:

- `frames`: Rendered image sequence (IMAGE)

- `mask_frames`: Foreground mask sequence (MASK)

## Timeline Operations

### UI Top Controls

1. **Resolution Control**: Directly input width × height in the UI (maximum preview 1920×1080, export uses actual resolution)

2. **FPS Settings**: Adjust animation frame rate (1-120)

3. **Total Frames**: Set the total animation length

4. **Apply Button**: Apply resolution, FPS, and total frame settings uniformly

5. **Import Image**: The `+Image` button imports a local image as a new layer

6. **Run Preview**: The `▶ Run` button executes the preview animation for this node individually

7. **Clear Cache**: `🗑 Clear Cache` releases memory for images of unselected layers

### Layer Operations

1. **Select Layer**: Select the current layer from the drop-down menu

2. **Adjusting Properties**: X, Y, Scale, Rotation, Opacity, Mask Size

3. **Layer Sorting**:

- `↑` Move up one layer

- `↓` Move down one layer

- `⇈` Place on top

- `⇊` Place on the bottom

### Keyframe Animation

1. **Adding a Keyframe**: Adjust the time slider to the target time → Adjust properties → Click `◆` to add

2. **Deleting a Keyframe**: Click the keyframe marker on the timeline → Click `✕` to delete

3. **Clear All**: Click `ALL` to clear all keyframes in the current layer

4. **Play Preview**: Click `▶` to play, `■` to stop

### Mask Function

1. Select the foreground layer

2. Click `🖌 Mask` to enable Mask mode

3. Adjust the brush size

4. Paint on the canvas (black = transparent, white = opaque)

5. Hold Shift or right-click to erase

6. **Jiggle Edges**: Drag the jiggle slider to add an irregular edge effect (0-10)

7. Click `✓ Apply Mask` to apply

### Bezier Path

1. Select the layer

2. Click `📍 Path` to create a path

3. Click on the four control points on the canvas (start point, control point 1, control point 2, end point)

4. Drag the points to adjust the path shape

5. Click `✓ Apply` to generate the path keyframe animation

### Background Extraction (Extract) ⭐

This is a unique feature of this node, allowing you to extract a portion of the background and create a new foreground layer:

1. **Preparation**: Ensure the background layer is loaded

2. **Start Extract**: Click the `✂ Extract` button

3. **Paint the Selection**:

- Use the brush to paint the area to be extracted on the background

- Adjust the brush size (10-100)

- Hold down Shift or right-click to erase any mistakes

4. **Choose Blur Type**:

- **Gaussian Blur**: Apply a uniform blur

- **Radial Blur:** Blurs from the center outwards (more natural)

5. **Apply Extraction:** Click `✓ Extract Region`

**Extraction Effects:**

- ✅ Automatically applies maximum intensity blur to the selected background area

- ✅ Creates a new foreground layer (extracted_X)

- ✅ The new layer can be independently adjusted in position, scale, and rotated

- ✅ Can add keyframes to achieve animation effects

- ✅ Supports multiple extractions to create multiple layers

**Application Scenarios:**

- Blur the background after cutting out a person

- Animate a specific element extracted from the background

- Depth of field effect (clear foreground, blurred background)

## Technical Features

### Data Persistence

- Automatically saves all layer attributes, keyframes, masks, and path data

- Reloading the workflow after saving restores all states

- Fully saves the extracted layer and its modifications

### Performance Optimization

- **Smart Compression:** Automatically compresses imported images to the canvas resolution, reducing memory usage

- **Lazy Loading:** Loads images on demand, preventing browser crashes

- **Cache Management**: Manually clear unused layer cache to free up memory.

- **Preview Limitation**: Maximum preview canvas resolution is 1920×1080, ensuring smooth performance for high-resolution projects.

- **Debounce Mechanism**: Reduces unnecessary save operations (300ms).

- **requestAnimationFrame**: Optimizes rendering performance.

- **Image Caching**: Reduces redundant loading.

### Batch Image Support

- Foreground image input supports 4D tensors `[B, H, W, C]`.

- Automatically splits into multiple layers.

- Each layer can be animated independently.

## Keyboard Shortcuts

- **Canvas Drag**: Left-click to drag the layer.

- **Layer Zoom**: Mouse wheel.

- **Mask Eraser**: Shift + Left Mouse Button or Right Mouse Button.

- **Extract Eraser**: Shift + Left Mouse Button or Right Mouse Button.

## Notes

1. **Project Size**: It is recommended to adjust the resolution within the UI. Preview is limited to 1920×1080; export using the actual resolution.

2. **Number of Layers**: Number of foreground layers = Batch number of foreground_images + Layers created by Extract + Locally imported layers

3. **Mask Resolution**: Masks will automatically scale to the original layer size.

4. **Extract Layers**: After creation, layers will automatically scale to the project size; scale=1 enables full-screen display.

5. **Memory Management**: Uses cache clearing to release memory when dealing with a large number of layers.

6. **External Layers**: Foreground_images connected via node input ports will automatically appear in the UI.

## Update Log

### v1.1.0 (Latest)

- ✅ **Import Images in UI**: Supports importing local images with automatic compression optimization.

- ✅ **Mask Edge Jitter**: Adjustable intensity of irregular edge effects.

- ✅ **UI Parameter Control**: Resolution, FPS, and total frame rate can be adjusted uniformly within the UI.

- ✅ **Single Node Preview**: Preview animations without running the entire workflow.

- ✅ **Performance Optimization**: Image compression, lazy loading, cache management.

- ✅ **Preview Limitations**: Maximum preview canvas size 1920×1080 to prevent browser crashes.

- ✅ **External Layer Display**: Automatically identifies and displays the foreground image of the node input port.

- ✅ **Default Parameter Adjustment**: 1280×720, 16fps, 81 frames

- ✅ Remove polygon masking function

### v1.0.0

- ✅ Core Animation Timeline Functionality

- ✅ Multi-Layer Management

- ✅ Keyframe Animation

- ✅ Mask Brush Editing

- ✅ Bezier Path Animation

- ✅ Background Extraction Functionality (Extract)

- ✅ Layer Sorting Functionality

- ✅ Batch Foreground Image Support

- ✅ Complete Data Persistence

- ✅ WebSocket Real-Time Preview

## Frequently Asked Questions

**Q: Why do Extract layers look small?**

A: Extract layers are automatically scaled to the project size; scale=1 indicates full screen. If they look small, please check your project size settings.

**Q: How do I center Extract layers?** **
A: The Extract layer defaults to x=0, y=0 (canvas center). To adjust, use the X/Y input boxes or drag directly.

**Q: Can I extract multiple times?**

A: Yes! Each Extract layer creates independent layers such as extracted_0, extracted_1, etc., which do not affect each other.

**Q: Keyframe animation is not working?**

A: Ensure at least two keyframes are added at different times, and the attribute values ​​change.

**Q: How to use Mask?**

A: Black areas are transparent, white areas are opaque. Use the brush to paint and then click Apply Mask.

## License

MIT License

## Author

wallen0322

## Contributions

Issues and PRs are welcome!

## Acknowledgements

Thanks to [jtydhr88](https://github.com/jtydhr88) for the guidance!

The timeline was inspired by: [vanilla-threejs-project](https://github.com/fulopkovacs/vanilla-threejs-project)

Thanks!

---

**Enjoy the fun of creating animations!** 🎬✨