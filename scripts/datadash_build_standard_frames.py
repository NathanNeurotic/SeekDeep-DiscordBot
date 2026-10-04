"""Build the DataDash 12-frame standard loop from the approved green sheet.

Every source pose is preserved. Registration is measured from image features
rather than hand-entered per-frame offsets:

1. Chroma-key each source cell.
2. Detect the helmet shell, chest core, and ear optic.
3. Apply one floating-point affine transform that maps those three anchors to
   a shared pose space.
4. Feather a local helmet-only correction so its visible center and dimensions
   remain stable without freezing the body animation.
5. Reject the build if helmet or chest-core drift exceeds the pixel budget.

Phase-correlation measurements remain diagnostic only; the generated frames
are registered by the detected image anchors above.
"""

from __future__ import annotations

import argparse
import math
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


CANVAS_SIZE = (460, 320)
HELMET_ANCHOR = (270.0, 78.0)
HELMET_ROI_RADIUS = 72
REFERENCE_FRAME = 6

# Main pose bounds measured on the approved source sheet. These bounds only
# isolate the poster cells; no registration data is encoded here.
FRAME_BOUNDS = (
    (37, 141, 298, 389),
    (320, 141, 590, 389),
    (598, 149, 866, 389),
    (890, 148, 1160, 386),
    (1180, 155, 1442, 385),
    (1470, 161, 1726, 387),
    (28, 522, 288, 753),
    (321, 524, 579, 756),
    (602, 528, 860, 756),
    (875, 527, 1150, 758),
    (1170, 529, 1440, 759),
    (1461, 531, 1731, 759),
)


def key_green(image: Image.Image) -> Image.Image:
    """Convert the green-screen backdrop to transparent pixels with despill."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8).copy()
    red = rgba[:, :, 0].astype(np.int16)
    green = rgba[:, :, 1].astype(np.int16)
    blue = rgba[:, :, 2].astype(np.int16)
    green_excess = green - np.maximum(red, blue)

    alpha = np.full(green.shape, 255.0, dtype=np.float32)
    transparent = green_excess >= 88
    feather = (green_excess > 28) & ~transparent
    t = (88.0 - green_excess[feather]) / 60.0
    t = t * t * (3.0 - 2.0 * t)
    alpha[transparent] = 0
    alpha[feather] = 255.0 * t
    alpha[alpha < 8] = 0

    # Edge pixels retain the source RGB even after alpha keying. Cap excess
    # green so interpolation cannot reveal a neon fringe in the game.
    edge = (alpha > 0) & (green_excess > 14)
    green[edge] = np.minimum(green[edge], np.maximum(red[edge], blue[edge]) + 14)

    rgba[:, :, 1] = np.clip(green, 0, 255).astype(np.uint8)
    rgba[:, :, 3] = alpha.astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    """Return 8-connected component coordinates for a small boolean mask."""
    height, width = mask.shape
    seen = np.zeros(mask.shape, dtype=bool)
    components: list[np.ndarray] = []
    for start_y, start_x in zip(*np.nonzero(mask)):
        if seen[start_y, start_x]:
            continue
        queue = deque([(int(start_y), int(start_x))])
        seen[start_y, start_x] = True
        points: list[tuple[int, int]] = []
        while queue:
            y, x = queue.popleft()
            points.append((y, x))
            for ny in range(max(0, y - 1), min(height, y + 2)):
                for nx in range(max(0, x - 1), min(width, x + 2)):
                    if mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
        components.append(np.asarray(points, dtype=np.int32))
    return components


def helmet_shell_mask(
    image: Image.Image,
    *,
    source_crop: bool,
) -> np.ndarray:
    """Find the bright helmet shell without including the shoulder or wake."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    height, width = alpha.shape

    bright = rgb.min(axis=2) >= 105
    low_chroma = (rgb.max(axis=2) - rgb.min(axis=2)) <= 105
    mask = (alpha >= 150) & bright & low_chroma

    yy, xx = np.ogrid[:height, :width]
    if source_crop:
        # The character faces right and the helmet is the dominant bright
        # component in this portion of every approved cell.
        mask &= (xx >= width * 0.43) & (yy <= height * 0.58)
    else:
        radius_sq = (xx - HELMET_ANCHOR[0]) ** 2 + (yy - HELMET_ANCHOR[1]) ** 2
        mask &= radius_sq <= HELMET_ROI_RADIUS**2

    components = connected_components(mask)
    if not components:
        raise RuntimeError("Could not identify a helmet component")

    component = max(
        components,
        key=lambda points: len(points)
        * (1.0 + float(points[:, 1].mean()) / max(1, width)),
    )
    result = np.zeros(mask.shape, dtype=bool)
    result[component[:, 0], component[:, 1]] = True
    return result


def mask_metrics(mask: np.ndarray) -> tuple[tuple[float, float], float]:
    yy, xx = np.nonzero(mask)
    if len(xx) < 100:
        raise RuntimeError(f"Helmet mask is too small ({len(xx)} pixels)")
    return (float(xx.mean()), float(yy.mean())), float(len(xx))


def core_marker_mask(
    image: Image.Image,
    *,
    source_crop: bool,
) -> np.ndarray:
    """Find the cyan chest core while excluding the face, joints, and wake."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    rgb = rgba[:, :, :3].astype(np.int16)
    alpha = rgba[:, :, 3]
    height, width = alpha.shape
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    mask = (
        (alpha >= 145)
        & (blue >= 135)
        & (green >= 75)
        & ((blue - red) >= 48)
        & ((green - red) >= 18)
    )

    yy, xx = np.ogrid[:height, :width]
    if source_crop:
        mask &= (
            (xx >= width * 0.52)
            & (xx <= width * 0.84)
            & (yy >= height * 0.34)
            & (yy <= height * 0.73)
        )
    else:
        mask &= (
            (xx >= HELMET_ANCHOR[0] - 115)
            & (xx <= HELMET_ANCHOR[0] + 8)
            & (yy >= HELMET_ANCHOR[1] + 38)
            & (yy <= HELMET_ANCHOR[1] + 145)
        )

    components = connected_components(mask)
    components = [points for points in components if len(points) >= 8]
    if not components:
        raise RuntimeError("Could not identify the cyan chest core")

    if source_crop:
        expected_x = width * 0.70
        expected_y = height * 0.52
    else:
        expected_x = HELMET_ANCHOR[0] - 35
        expected_y = HELMET_ANCHOR[1] + 95

    component = max(
        components,
        key=lambda points: len(points)
        / (
            1.0
            + math.hypot(
                float(points[:, 1].mean()) - expected_x,
                float(points[:, 0].mean()) - expected_y,
            )
            * 0.04
        ),
    )
    result = np.zeros(mask.shape, dtype=bool)
    result[component[:, 0], component[:, 1]] = True
    return result


def ear_marker_mask(
    image: Image.Image,
    helmet_center: tuple[float, float],
) -> np.ndarray:
    """Find the cyan circular optic on the left side of the helmet."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    rgb = rgba[:, :, :3].astype(np.int16)
    alpha = rgba[:, :, 3]
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    mask = (
        (alpha >= 145)
        & (blue >= 135)
        & (green >= 70)
        & ((blue - red) >= 45)
        & ((green - red) >= 15)
    )
    yy, xx = np.ogrid[:alpha.shape[0], :alpha.shape[1]]
    expected_x = helmet_center[0] - 38
    expected_y = helmet_center[1] + 13
    mask &= (
        ((xx - helmet_center[0]) ** 2 + (yy - helmet_center[1]) ** 2 <= 68**2)
        & (xx <= helmet_center[0] - 7)
        & (yy >= helmet_center[1] - 34)
        & (yy <= helmet_center[1] + 48)
    )
    components = connected_components(mask)
    components = [points for points in components if len(points) >= 8]
    if not components:
        raise RuntimeError("Could not identify the helmet ear optic")
    component = max(
        components,
        key=lambda points: len(points)
        / (
            1.0
            + math.hypot(
                float(points[:, 1].mean()) - expected_x,
                float(points[:, 0].mean()) - expected_y,
            )
            * 0.07
        ),
    )
    result = np.zeros(mask.shape, dtype=bool)
    result[component[:, 0], component[:, 1]] = True
    return result


def place_initial_frame(
    keyed: Image.Image,
    source_center: tuple[float, float],
    scale: float,
    rotation: float,
) -> Image.Image:
    size = (
        max(1, round(keyed.width * scale)),
        max(1, round(keyed.height * scale)),
    )
    scaled = keyed.resize(size, Image.Resampling.LANCZOS)
    scaled_center = (source_center[0] * scale, source_center[1] * scale)
    paste_at = (
        round(HELMET_ANCHOR[0] - scaled_center[0]),
        round(HELMET_ANCHOR[1] - scaled_center[1]),
    )
    frame = Image.new("RGBA", CANVAS_SIZE, (0, 0, 0, 0))
    frame.alpha_composite(scaled, paste_at)
    return affine_frame(frame, angle_degrees=rotation)


def place_from_anchor_pair(
    keyed: Image.Image,
    source_helmet: tuple[float, float],
    source_core: tuple[float, float],
    target_core: tuple[float, float],
) -> tuple[Image.Image, float, float]:
    """Map both source anchors in one subpixel affine operation."""
    source_vector = (
        source_core[0] - source_helmet[0],
        source_core[1] - source_helmet[1],
    )
    target_vector = (
        target_core[0] - HELMET_ANCHOR[0],
        target_core[1] - HELMET_ANCHOR[1],
    )
    source_distance = math.hypot(*source_vector)
    target_distance = math.hypot(*target_vector)
    scale = target_distance / source_distance
    source_angle = math.atan2(source_vector[1], source_vector[0])
    target_angle = math.atan2(target_vector[1], target_vector[0])
    angle = target_angle - source_angle

    # Forward transform:
    # output = target_helmet + scale * R * (source - source_helmet)
    # PIL expects the inverse output-to-source matrix.
    cosine = math.cos(angle)
    sine = math.sin(angle)
    inv_scale = 1.0 / scale
    a = cosine * inv_scale
    b = sine * inv_scale
    d = -sine * inv_scale
    e = cosine * inv_scale
    c = source_helmet[0] - a * HELMET_ANCHOR[0] - b * HELMET_ANCHOR[1]
    f = source_helmet[1] - d * HELMET_ANCHOR[0] - e * HELMET_ANCHOR[1]
    frame = keyed.transform(
        CANVAS_SIZE,
        Image.Transform.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC,
    )
    return frame, scale, math.degrees(angle)


def place_from_anchor_triangle(
    keyed: Image.Image,
    source_helmet: tuple[float, float],
    source_core: tuple[float, float],
    source_ear: tuple[float, float],
    target_core: tuple[float, float],
    target_ear: tuple[float, float],
) -> tuple[Image.Image, float, float, float]:
    """Map helmet, core, and ear anchors in one affine operation."""
    source_points = np.asarray(
        [
            [source_helmet[0], source_helmet[1], 1.0],
            [source_core[0], source_core[1], 1.0],
            [source_ear[0], source_ear[1], 1.0],
        ],
        dtype=np.float64,
    )
    target_points = np.asarray(
        [
            [HELMET_ANCHOR[0], HELMET_ANCHOR[1]],
            [target_core[0], target_core[1]],
            [target_ear[0], target_ear[1]],
        ],
        dtype=np.float64,
    )
    coefficients = np.linalg.solve(source_points, target_points)
    forward = np.asarray(
        [
            [coefficients[0, 0], coefficients[1, 0], coefficients[2, 0]],
            [coefficients[0, 1], coefficients[1, 1], coefficients[2, 1]],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    inverse = np.linalg.inv(forward)
    frame = keyed.transform(
        CANVAS_SIZE,
        Image.Transform.AFFINE,
        (
            float(inverse[0, 0]),
            float(inverse[0, 1]),
            float(inverse[0, 2]),
            float(inverse[1, 0]),
            float(inverse[1, 1]),
            float(inverse[1, 2]),
        ),
        resample=Image.Resampling.BICUBIC,
    )
    linear = forward[:2, :2]
    singular_values = np.linalg.svd(linear, compute_uv=False)
    scale = float(math.sqrt(abs(np.linalg.det(linear))))
    anisotropy = float(max(singular_values) / min(singular_values))
    angle = math.degrees(math.atan2(linear[1, 0], linear[0, 0]))
    return frame, scale, angle, anisotropy


def affine_frame(
    image: Image.Image,
    *,
    scale: float = 1.0,
    angle_degrees: float = 0.0,
    translate: tuple[float, float] = (0.0, 0.0),
) -> Image.Image:
    """Apply a forward similarity transform around the shared helmet anchor."""
    angle = math.radians(angle_degrees)
    cosine = math.cos(angle)
    sine = math.sin(angle)
    inv_scale = 1.0 / scale
    a = cosine * inv_scale
    b = sine * inv_scale
    d = -sine * inv_scale
    e = cosine * inv_scale
    center_x, center_y = HELMET_ANCHOR
    tx, ty = translate
    c = center_x - a * (center_x + tx) - b * (center_y + ty)
    f = center_y - d * (center_x + tx) - e * (center_y + ty)
    return image.transform(
        CANVAS_SIZE,
        Image.Transform.AFFINE,
        (a, b, c, d, e, f),
        resample=Image.Resampling.BICUBIC,
    )


def helmet_feature(image: Image.Image) -> np.ndarray:
    """Build a high-frequency helmet-only map for image correlation."""
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    luma = rgb[:, :, 0] * 0.2126 + rgb[:, :, 1] * 0.7152 + rgb[:, :, 2] * 0.0722
    gradient = (
        np.abs(np.diff(luma, axis=1, prepend=luma[:, :1]))
        + np.abs(np.diff(luma, axis=0, prepend=luma[:1, :]))
        + 0.65 * np.abs(np.diff(alpha, axis=1, prepend=alpha[:, :1]))
        + 0.65 * np.abs(np.diff(alpha, axis=0, prepend=alpha[:1, :]))
    )

    x0 = round(HELMET_ANCHOR[0] - HELMET_ROI_RADIUS)
    y0 = round(HELMET_ANCHOR[1] - HELMET_ROI_RADIUS)
    x1 = round(HELMET_ANCHOR[0] + HELMET_ROI_RADIUS)
    y1 = round(HELMET_ANCHOR[1] + HELMET_ROI_RADIUS)
    feature = gradient[y0:y1, x0:x1].copy()
    height, width = feature.shape
    yy, xx = np.ogrid[:height, :width]
    circle = (
        (xx - width / 2) ** 2 + (yy - height / 2) ** 2
        <= (HELMET_ROI_RADIUS - 3) ** 2
    )
    window = np.outer(np.hanning(height), np.hanning(width))
    feature *= circle * window
    feature -= feature.mean()
    norm = np.linalg.norm(feature)
    return feature / norm if norm > 1e-9 else feature


def subpixel_peak(values: np.ndarray, index: int) -> float:
    before = float(values[(index - 1) % len(values)])
    center = float(values[index])
    after = float(values[(index + 1) % len(values)])
    denominator = before - 2.0 * center + after
    if abs(denominator) < 1e-9:
        return 0.0
    return max(-0.5, min(0.5, 0.5 * (before - after) / denominator))


def phase_shift(reference: np.ndarray, candidate: np.ndarray) -> tuple[float, float]:
    """Return the translation that aligns candidate to reference."""
    ref_fft = np.fft.fft2(reference)
    cand_fft = np.fft.fft2(candidate)
    cross_power = ref_fft * np.conj(cand_fft)
    magnitude = np.abs(cross_power)
    cross_power /= np.where(magnitude < 1e-9, 1.0, magnitude)
    correlation = np.fft.ifft2(cross_power).real
    peak_y, peak_x = np.unravel_index(np.argmax(correlation), correlation.shape)
    delta_x = float(peak_x)
    delta_y = float(peak_y)
    if delta_x > correlation.shape[1] / 2:
        delta_x -= correlation.shape[1]
    if delta_y > correlation.shape[0] / 2:
        delta_y -= correlation.shape[0]
    delta_x += subpixel_peak(correlation[peak_y, :], peak_x)
    delta_y += subpixel_peak(correlation[:, peak_x], peak_y)
    return delta_x, delta_y


def correlation_score(reference: np.ndarray, candidate: np.ndarray) -> float:
    denominator = np.linalg.norm(reference) * np.linalg.norm(candidate)
    return float(np.sum(reference * candidate) / denominator) if denominator else -1.0


def register_to_reference(
    frame: Image.Image,
    reference_feature: np.ndarray,
) -> tuple[Image.Image, float, float, float, float, float]:
    """Search rotation/scale, then phase-align and center the helmet shell."""
    best: tuple[float, Image.Image, float, float, float, float] | None = None

    search_passes = (
        (np.arange(0.965, 1.036, 0.01), np.arange(-3.0, 3.01, 0.5)),
        (None, None),
    )
    best_scale = 1.0
    best_angle = 0.0
    for pass_index, (scales, angles) in enumerate(search_passes):
        if pass_index:
            scales = np.arange(best_scale - 0.008, best_scale + 0.0081, 0.002)
            angles = np.arange(best_angle - 0.45, best_angle + 0.451, 0.1)
        assert scales is not None and angles is not None
        for scale in scales:
            for angle in angles:
                candidate = affine_frame(
                    frame,
                    scale=float(scale),
                    angle_degrees=float(angle),
                )
                feature = helmet_feature(candidate)
                shift_x, shift_y = phase_shift(reference_feature, feature)
                if abs(shift_x) > 10 or abs(shift_y) > 10:
                    continue
                shifted = affine_frame(candidate, translate=(shift_x, shift_y))
                score = correlation_score(reference_feature, helmet_feature(shifted))
                if best is None or score > best[0]:
                    best = (
                        score,
                        shifted,
                        float(scale),
                        float(angle),
                        shift_x,
                        shift_y,
                    )
                    best_scale = float(scale)
                    best_angle = float(angle)

    if best is None:
        raise RuntimeError("Helmet correlation search failed")

    score, registered, scale, angle, shift_x, shift_y = best

    return (
        registered,
        scale,
        angle,
        shift_x,
        shift_y,
        score,
    )


def lock_helmet_geometry(
    frame: Image.Image,
    target_area: float,
) -> tuple[Image.Image, tuple[float, float], float, float, float]:
    """Iteratively lock helmet shell area and center after interpolation."""
    total_scale = 1.0
    total_x = 0.0
    total_y = 0.0
    locked = frame
    for _ in range(4):
        shell = helmet_shell_mask(locked, source_crop=False)
        center, area = mask_metrics(shell)
        scale_fix = math.sqrt(target_area / area)
        center_fix = (
            HELMET_ANCHOR[0] - center[0],
            HELMET_ANCHOR[1] - center[1],
        )
        if (
            abs(scale_fix - 1.0) < 0.0005
            and math.hypot(*center_fix) < 0.08
        ):
            break
        locked = affine_frame(
            locked,
            scale=scale_fix,
            translate=center_fix,
        )
        total_scale *= scale_fix
        total_x += center_fix[0]
        total_y += center_fix[1]

    # A final center-only pass removes the tiny centroid displacement caused by
    # the last scale interpolation.
    for _ in range(3):
        shell = helmet_shell_mask(locked, source_crop=False)
        center, area = mask_metrics(shell)
        center_fix = (
            HELMET_ANCHOR[0] - center[0],
            HELMET_ANCHOR[1] - center[1],
        )
        if math.hypot(*center_fix) < 0.08:
            break
        locked = affine_frame(locked, translate=center_fix)
        total_x += center_fix[0]
        total_y += center_fix[1]

    shell = helmet_shell_mask(locked, source_crop=False)
    center, area = mask_metrics(shell)
    return locked, center, area, total_scale, math.hypot(total_x, total_y)


def lock_anchor_pair(
    frame: Image.Image,
    target_core: tuple[float, float],
) -> tuple[
    Image.Image,
    tuple[float, float],
    tuple[float, float],
    float,
    float,
]:
    """Lock helmet and chest-core centers to one shared similarity transform."""
    locked = frame
    total_scale = 1.0
    total_angle = 0.0
    target_vector = (
        target_core[0] - HELMET_ANCHOR[0],
        target_core[1] - HELMET_ANCHOR[1],
    )
    target_distance = math.hypot(*target_vector)
    target_angle = math.atan2(target_vector[1], target_vector[0])

    for _ in range(5):
        helmet, _ = mask_metrics(
            helmet_shell_mask(locked, source_crop=False)
        )
        core, _ = mask_metrics(
            core_marker_mask(locked, source_crop=False)
        )
        current_vector = (core[0] - helmet[0], core[1] - helmet[1])
        current_distance = math.hypot(*current_vector)
        current_angle = math.atan2(current_vector[1], current_vector[0])
        scale_fix = target_distance / current_distance
        angle_fix = math.degrees(target_angle - current_angle)
        center_fix = (
            HELMET_ANCHOR[0] - helmet[0],
            HELMET_ANCHOR[1] - helmet[1],
        )
        if (
            math.hypot(*center_fix) < 0.08
            and abs(scale_fix - 1.0) < 0.0005
            and abs(angle_fix) < 0.02
        ):
            break
        locked = affine_frame(locked, translate=center_fix)
        locked = affine_frame(
            locked,
            scale=scale_fix,
            angle_degrees=angle_fix,
        )
        total_scale *= scale_fix
        total_angle += angle_fix

    helmet, _ = mask_metrics(helmet_shell_mask(locked, source_crop=False))
    core, _ = mask_metrics(core_marker_mask(locked, source_crop=False))
    return locked, helmet, core, total_scale, total_angle


def head_silhouette_metrics(
    image: Image.Image,
) -> tuple[tuple[float, float], float, float, float]:
    """Measure the visible helmet silhouette in a fixed head-only aperture."""
    alpha = np.asarray(image.convert("RGBA"), dtype=np.uint8)[:, :, 3]
    yy, xx = np.ogrid[:alpha.shape[0], :alpha.shape[1]]
    aperture = (
        ((xx - HELMET_ANCHOR[0]) / 68.0) ** 2
        + ((yy - (HELMET_ANCHOR[1] + 10)) / 66.0) ** 2
        <= 1.0
    )
    mask = (alpha >= 160) & aperture
    ys, xs = np.nonzero(mask)
    if len(xs) < 1000:
        raise RuntimeError(
            f"Helmet silhouette is too small ({len(xs)} pixels)"
        )
    width = float(xs.max() - xs.min() + 1)
    height = float(ys.max() - ys.min() + 1)
    center = (float(xs.mean()), float(ys.mean()))
    return center, width, height, float(len(xs))


def warp_head_to_metrics(
    image: Image.Image,
    target_center: tuple[float, float],
    target_width: float,
    target_height: float,
) -> Image.Image:
    """Normalize the head locally, feathering out before the chest core."""
    normalized = image
    for _ in range(3):
        center, width, height, _ = head_silhouette_metrics(normalized)
        scale_x = target_width / width
        scale_y = target_height / height
        if (
            math.dist(center, target_center) < 0.12
            and abs(scale_x - 1.0) < 0.001
            and abs(scale_y - 1.0) < 0.001
        ):
            break

        inverse = (
            1.0 / scale_x,
            0.0,
            center[0] - target_center[0] / scale_x,
            0.0,
            1.0 / scale_y,
            center[1] - target_center[1] / scale_y,
        )
        warped = normalized.transform(
            CANVAS_SIZE,
            Image.Transform.AFFINE,
            inverse,
            resample=Image.Resampling.BICUBIC,
        )

        yy, xx = np.ogrid[:CANVAS_SIZE[1], :CANVAS_SIZE[0]]
        radius = np.sqrt(
            ((xx - target_center[0]) / 78.0) ** 2
            + ((yy - target_center[1]) / 72.0) ** 2
        )
        blend = np.clip((1.0 - radius) / 0.22, 0.0, 1.0)
        blend = blend * blend * (3.0 - 2.0 * blend)

        base = np.asarray(normalized, dtype=np.float32) / 255.0
        top = np.asarray(warped, dtype=np.float32) / 255.0
        weight = blend[:, :, None]
        base_alpha = base[:, :, 3:4]
        top_alpha = top[:, :, 3:4]
        out_alpha = top_alpha * weight + base_alpha * (1.0 - weight)
        out_premultiplied = (
            top[:, :, :3] * top_alpha * weight
            + base[:, :, :3] * base_alpha * (1.0 - weight)
        )
        out_rgb = np.divide(
            out_premultiplied,
            np.maximum(out_alpha, 1e-6),
            out=np.zeros_like(out_premultiplied),
            where=out_alpha > 1e-6,
        )
        output = np.concatenate((out_rgb, out_alpha), axis=2)
        normalized = Image.fromarray(
            np.clip(output * 255.0, 0, 255).astype(np.uint8),
            "RGBA",
        )
    return normalized


def checkerboard(size: tuple[int, int], tile: int = 16) -> Image.Image:
    preview = Image.new("RGB", size, "#d6d6d6")
    draw = ImageDraw.Draw(preview)
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill="#a8a8a8")
    return preview


def write_previews(
    frames: list[Image.Image],
    preview_path: Path | None,
    gif_path: Path | None,
) -> None:
    if preview_path:
        columns = 6
        rows = 2
        preview = checkerboard((CANVAS_SIZE[0] * columns, CANVAS_SIZE[1] * rows))
        for index, frame in enumerate(frames):
            x = (index % columns) * CANVAS_SIZE[0]
            y = (index // columns) * CANVAS_SIZE[1]
            preview.paste(frame, (x, y), frame)
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        preview.save(preview_path, optimize=True)

    if gif_path:
        rendered: list[Image.Image] = []
        for frame in frames:
            background = Image.new("RGB", CANVAS_SIZE, "#061522")
            background.paste(frame, (0, 0), frame)
            draw = ImageDraw.Draw(background)
            x, y = HELMET_ANCHOR
            draw.line((x - 8, y, x + 8, y), fill="#ff4d6d", width=1)
            draw.line((x, y - 8, x, y + 8), fill="#ff4d6d", width=1)
            rendered.append(background)
        gif_path.parent.mkdir(parents=True, exist_ok=True)
        rendered[0].save(
            gif_path,
            save_all=True,
            append_images=rendered[1:],
            duration=round(1000 / 12),
            loop=0,
            optimize=False,
        )


def build(
    source_path: Path,
    output_dir: Path,
    preview_path: Path | None,
    gif_path: Path | None,
) -> None:
    source = Image.open(source_path).convert("RGB")
    output_dir.mkdir(parents=True, exist_ok=True)

    keyed_crops: list[Image.Image] = []
    source_helmet_centers: list[tuple[float, float]] = []
    source_core_centers: list[tuple[float, float]] = []
    source_ear_centers: list[tuple[float, float]] = []
    shell_areas: list[float] = []
    for bounds in FRAME_BOUNDS:
        left, top, right, bottom = bounds
        keyed = key_green(source.crop((left, top, right + 1, bottom + 1)))
        shell = helmet_shell_mask(keyed, source_crop=True)
        helmet_center, area = mask_metrics(shell)
        core_center, _ = mask_metrics(
            core_marker_mask(keyed, source_crop=True)
        )
        ear_center, _ = mask_metrics(
            ear_marker_mask(keyed, helmet_center)
        )
        keyed_crops.append(keyed)
        source_helmet_centers.append(helmet_center)
        source_core_centers.append(core_center)
        source_ear_centers.append(ear_center)
        shell_areas.append(area)

    source_vectors = [
        (core[0] - helmet[0], core[1] - helmet[1])
        for helmet, core in zip(
            source_helmet_centers,
            source_core_centers,
            strict=True,
        )
    ]
    source_distances = [math.hypot(*vector) for vector in source_vectors]
    source_angles = [
        math.atan2(vector[1], vector[0])
        for vector in source_vectors
    ]
    target_distance = float(np.median(source_distances))
    target_angle = float(np.median(source_angles))
    target_core = (
        HELMET_ANCHOR[0] + math.cos(target_angle) * target_distance,
        HELMET_ANCHOR[1] + math.sin(target_angle) * target_distance,
    )
    ear_vectors = [
        (ear[0] - helmet[0], ear[1] - helmet[1])
        for helmet, ear in zip(
            source_helmet_centers,
            source_ear_centers,
            strict=True,
        )
    ]
    target_ear = (
        HELMET_ANCHOR[0]
        + float(np.median([vector[0] for vector in ear_vectors])),
        HELMET_ANCHOR[1]
        + float(np.median([vector[1] for vector in ear_vectors])),
    )
    initial_frames = []
    initial_transforms: list[tuple[float, float, float]] = []
    for keyed, helmet, core, ear in zip(
        keyed_crops,
        source_helmet_centers,
        source_core_centers,
        source_ear_centers,
        strict=True,
    ):
        frame, scale, rotation, anisotropy = place_from_anchor_triangle(
            keyed,
            helmet,
            core,
            ear,
            target_core,
            target_ear,
        )
        initial_frames.append(frame)
        initial_transforms.append((scale, rotation, anisotropy))

    raw_head_metrics = [
        head_silhouette_metrics(frame)
        for frame in initial_frames
    ]
    target_head_center = (
        float(np.median([metrics[0][0] for metrics in raw_head_metrics])),
        float(np.median([metrics[0][1] for metrics in raw_head_metrics])),
    )
    target_head_width = float(
        np.median([metrics[1] for metrics in raw_head_metrics])
    )
    target_head_height = float(
        np.median([metrics[2] for metrics in raw_head_metrics])
    )
    frames = [
        warp_head_to_metrics(
            frame,
            target_head_center,
            target_head_width,
            target_head_height,
        )
        for frame in initial_frames
    ]

    reference_feature = helmet_feature(frames[REFERENCE_FRAME - 1])
    reports: list[dict[str, object]] = []
    for index, (registered, transform) in enumerate(
        zip(frames, initial_transforms, strict=True),
        start=1,
    ):
        scale, angle, anisotropy = transform
        head_center, head_width, head_height, head_area = (
            head_silhouette_metrics(registered)
        )
        core_center, _ = mask_metrics(
            core_marker_mask(registered, source_crop=False)
        )
        ear_center, _ = mask_metrics(
            ear_marker_mask(registered, head_center)
        )
        score = correlation_score(
            reference_feature,
            helmet_feature(registered),
        )
        residual_x, residual_y = phase_shift(
            reference_feature,
            helmet_feature(registered),
        )
        alpha_bounds = registered.getchannel("A").getbbox()
        if not alpha_bounds:
            raise RuntimeError(f"Frame {index:02d} is empty after registration")
        if (
            alpha_bounds[0] <= 0
            or alpha_bounds[1] <= 0
            or alpha_bounds[2] >= CANVAS_SIZE[0]
            or alpha_bounds[3] >= CANVAS_SIZE[1]
        ):
            raise RuntimeError(
                f"Frame {index:02d} touches the canvas edge: {alpha_bounds}"
            )
        reports.append(
            {
                "index": index,
                "scale": scale,
                "angle": angle,
                "score": score,
                "alpha_bounds": alpha_bounds,
                "head_center": head_center,
                "head_width": head_width,
                "head_height": head_height,
                "head_area": head_area,
                "core_center": core_center,
                "ear_center": ear_center,
                "residual": math.hypot(residual_x, residual_y),
                "anisotropy": anisotropy,
            }
        )

    center_errors = [
        math.dist(report["head_center"], target_head_center)
        for report in reports
    ]
    core_errors = [
        math.dist(report["core_center"], target_core)
        for report in reports
    ]
    ear_errors = [
        math.dist(report["ear_center"], target_ear)
        for report in reports
    ]
    width_errors = [
        abs(float(report["head_width"]) - target_head_width)
        for report in reports
    ]
    height_errors = [
        abs(float(report["head_height"]) - target_head_height)
        for report in reports
    ]
    residuals = [float(report["residual"]) for report in reports]
    anisotropies = [float(report["anisotropy"]) for report in reports]
    print(
        "stability candidate: "
        f"head_center_max={max(center_errors):.3f}px "
        f"head_width_max={max(width_errors):.3f}px "
        f"head_height_max={max(height_errors):.3f}px "
        f"core_max={max(core_errors):.3f}px "
        f"ear_max={max(ear_errors):.3f}px "
        f"residual_max={max(residuals):.3f}px "
        f"anisotropy_max={max(anisotropies):.4f}"
    )
    write_previews(frames, preview_path, gif_path)
    if max(center_errors) > 0.75:
        raise RuntimeError(
            f"Helmet center stability failed: {max(center_errors):.3f}px"
        )
    if max(core_errors) > 1.0:
        raise RuntimeError(
            f"Chest-core stability failed: {max(core_errors):.3f}px"
        )
    if max(width_errors) > 1.5:
        raise RuntimeError(
            f"Helmet width stability failed: {max(width_errors):.3f}px"
        )
    if max(height_errors) > 1.5:
        raise RuntimeError(
            f"Helmet height stability failed: {max(height_errors):.3f}px"
        )
    if max(anisotropies) > 1.15:
        raise RuntimeError(
            f"Affine distortion exceeded budget: {max(anisotropies):.4f}"
        )

    # Write only after every frame passes validation. The runtime directory can
    # never contain a mixed old/new animation set.
    for frame, report in zip(frames, reports, strict=True):
        index = int(report["index"])
        output_path = output_dir / f"standard_{index:02d}.png"
        temporary_path = output_path.with_suffix(".png.tmp")
        frame.save(temporary_path, format="PNG", optimize=True)
        temporary_path.replace(output_path)
        head_center = report["head_center"]
        core_center = report["core_center"]
        ear_center = report["ear_center"]
        print(
            f"{output_path.name}: scale={float(report['scale']):.5f} "
            f"rotation={float(report['angle']):+.3f}deg "
            f"corr={float(report['score']):.5f} "
            f"residual={float(report['residual']):.3f}px "
            f"head=({head_center[0]:.3f},{head_center[1]:.3f}) "
            f"{float(report['head_width']):.0f}x"
            f"{float(report['head_height']):.0f} "
            f"core=({core_center[0]:.3f},{core_center[1]:.3f}) "
            f"ear=({ear_center[0]:.3f},{ear_center[1]:.3f}) "
            f"anisotropy={float(report['anisotropy']):.4f} "
            f"alpha={report['alpha_bounds']}"
        )

    print(
        "stability: "
        f"head_center_max={max(center_errors):.3f}px "
        f"head_width_max={max(width_errors):.3f}px "
        f"head_height_max={max(height_errors):.3f}px "
        f"core_max={max(core_errors):.3f}px "
        f"ear_max={max(ear_errors):.3f}px "
        f"residual_max={max(residuals):.3f}px "
        f"anisotropy_max={max(anisotropies):.4f}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--preview", type=Path)
    parser.add_argument("--gif", type=Path)
    args = parser.parse_args()
    build(args.source, args.out_dir, args.preview, args.gif)


if __name__ == "__main__":
    main()
