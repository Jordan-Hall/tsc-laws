# Blender 4.3 photorealistic 3D studio launch film for tslaws 1.2.
# Renders physically-based machined titanium, optical crystal glass, volumetric studio lighting,
# real glossy basalt floor reflections, depth-of-field bokeh, and REAL live-recorded video textures
# (live tslaws check runs + 3 parallel Chromium browser recordings) mapped onto floating 3D glass cinema displays.
#
# Run:
#   blender --background --python scripts/film-1.2/scene.py -- --out D:\tmp\film-1.2-blender --mode preview|full --engine CYCLES|EEVEE

import argparse
import json
import math
import os
import sys
import time
import bpy
from mathutils import Euler, Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--timing", required=True)
    p.add_argument("--mode", choices=["preview", "full"], default="preview")
    p.add_argument("--engine", choices=["CYCLES", "EEVEE"], default="CYCLES")
    p.add_argument("--samples", type=int, default=16)
    p.add_argument("--res-scale", type=int, default=100)
    p.add_argument("--fps", type=int, default=None)
    p.add_argument("--start", type=int, default=None)
    p.add_argument("--end", type=int, default=None)
    return p.parse_args(argv)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def set_key(obj, data_path, value, frame, interp="BEZIER"):
    if "." in data_path:
        parts = data_path.split(".")
        target = obj
        for p in parts[:-1]:
            target = getattr(target, p)
        setattr(target, parts[-1], value)
        target.keyframe_insert(data_path=parts[-1], frame=frame)
    else:
        setattr(obj, data_path, value)
        obj.keyframe_insert(data_path=data_path, frame=frame)
    if obj.animation_data and obj.animation_data.action:
        for fc in obj.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                if abs(kp.co.x - frame) < 0.01:
                    kp.interpolation = interp


def set_input_key(node, input_name, value, frame, interp="BEZIER"):
    sock = node.inputs[input_name]
    sock.default_value = value
    sock.keyframe_insert(data_path="default_value", frame=frame)
    nt = node.id_data
    if nt.animation_data and nt.animation_data.action:
        for fc in nt.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                if abs(kp.co.x - frame) < 0.01:
                    kp.interpolation = interp


# ---------------- MATERIALS (PBR STUDIO LOOK-DEV) ----------------


def make_basalt_floor_mat():
    mat = bpy.data.materials.new("BasaltFloor")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.014, 0.018, 0.026, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.25
    bsdf.inputs["IOR"].default_value = 1.55
    bsdf.inputs["Coat Weight"].default_value = 0.65
    bsdf.inputs["Coat Roughness"].default_value = 0.06

    tex_coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (3.5, 3.5, 1.0)

    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 18.0
    noise.inputs["Detail"].default_value = 8.0
    noise.inputs["Roughness"].default_value = 0.62

    noise_fine = nt.nodes.new("ShaderNodeTexNoise")
    noise_fine.inputs["Scale"].default_value = 140.0
    noise_fine.inputs["Detail"].default_value = 6.0

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.25
    ramp.color_ramp.elements[0].color = (0.08, 0.08, 0.08, 1.0)
    ramp.color_ramp.elements[1].position = 0.78
    ramp.color_ramp.elements[1].color = (0.24, 0.24, 0.24, 1.0)

    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.045
    bump.inputs["Distance"].default_value = 0.015

    nt.links.new(tex_coord.outputs["Object"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], noise_fine.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Roughness"])
    nt.links.new(noise_fine.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_titanium_mat(name="AnodizedTitanium", color=(0.13, 0.15, 0.19, 1.0), rough=0.22):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = 0.94
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Coat Weight"].default_value = 0.25
    bsdf.inputs["Coat Roughness"].default_value = 0.12

    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (80.0, 6.0, 6.0)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 12.0
    noise.inputs["Detail"].default_value = 6.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.03
    bump.inputs["Distance"].default_value = 0.005

    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], noise.inputs["Vector"])
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_brass_mat(name="BrushedBrass"):
    return make_titanium_mat(name, color=(0.82, 0.62, 0.28, 1.0), rough=0.20)


def make_silver_title_mat(name="MachinedSilver", em_col=(0.82, 0.94, 1.0, 1.0), em_str=1.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.92, 0.96, 1.0, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.65
    bsdf.inputs["Roughness"].default_value = 0.14
    bsdf.inputs["Coat Weight"].default_value = 0.5
    bsdf.inputs["Emission Color"].default_value = em_col
    bsdf.inputs["Emission Strength"].default_value = em_str
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def make_optical_glass_mat(name="OpticalGlass", tint=(0.82, 0.96, 0.98, 1.0), rough=0.04, emission_col=None, emission_str=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = tint
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["IOR"].default_value = 1.52
    bsdf.inputs["Transmission Weight"].default_value = 0.92
    bsdf.inputs["Coat Weight"].default_value = 0.9
    bsdf.inputs["Coat Roughness"].default_value = 0.02
    if emission_col is not None:
        bsdf.inputs["Emission Color"].default_value = emission_col
        bsdf.inputs["Emission Strength"].default_value = emission_str
    if hasattr(mat, "use_raytrace_refraction"):
        mat.use_raytrace_refraction = True
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat, bsdf


def make_emission_mat(name, color, strength=4.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = 0.15
    bsdf.inputs["Emission Color"].default_value = color
    bsdf.inputs["Emission Strength"].default_value = strength
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat, bsdf


def make_movie_screen_mat(name, video_path, start_frame, duration_frames, strength=1.55):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (0.01, 0.01, 0.015, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.08
    bsdf.inputs["Coat Weight"].default_value = 0.85
    bsdf.inputs["Coat Roughness"].default_value = 0.03
    bsdf.inputs["Emission Strength"].default_value = strength

    tex = nt.nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.load(video_path, check_existing=True)
    img.source = "MOVIE"
    tex.image = img
    tex.image_user.frame_duration = max(1, int(duration_frames))
    tex.image_user.frame_start = int(start_frame)
    tex.image_user.frame_offset = 0
    tex.image_user.use_auto_refresh = True
    tex.image_user.use_cyclic = False
    tex.extension = "CLIP"

    nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


# ---------------- GEOMETRY HELPERS ----------------


def add_bevel(obj, width=0.02, segments=4):
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth()


def make_box(name, loc, scale, mat, rot=(0, 0, 0), bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel > 0:
        add_bevel(obj, width=bevel, segments=4)
    return obj


def make_cyl(name, loc, radius, depth, mat, rot=(0, 0, 0), verts=64, bevel=0.012):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    if bevel > 0:
        add_bevel(obj, width=bevel, segments=4)
    return obj


def make_torus(name, loc, major_r, minor_r, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=96,
        minor_segments=32,
        major_radius=major_r,
        minor_radius=minor_r,
        location=loc,
        rotation=rot,
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


def make_3d_text(name, body, loc, size, mat, rot=(math.pi / 2, 0, 0), extrude=0.035, bevel=0.006, align="CENTER", font_path=None):
    bpy.ops.object.text_add(location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.body = body
    obj.data.size = size
    obj.data.align_x = align
    obj.data.align_y = "CENTER"
    obj.data.extrude = extrude
    obj.data.bevel_depth = bevel
    obj.data.bevel_resolution = 3
    if font_path and os.path.exists(font_path):
        obj.data.font = bpy.data.fonts.load(font_path, check_existing=True)
    obj.data.materials.append(mat)
    return obj


def make_cinema_display(name, loc, rot_deg, width, height, video_path, start_frame, dur_frames, titanium_mat, accent_mat):
    """Builds a physical floating anodized-titanium cinema display with glowing edge trim & live MOVIE screen."""
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    root.location = Vector(loc)
    root.rotation_euler = Euler(tuple(math.radians(a) for a in rot_deg), "XYZ")

    # Outer beveled aluminum chassis
    chassis = make_box(f"{name}_Chassis", (0, 0.045, 0), (width + 0.14, 0.08, height + 0.14), titanium_mat, bevel=0.022)
    chassis.parent = root

    # Subtle glowing back-rim strip
    rim = make_box(f"{name}_Rim", (0, 0.078, 0), (width + 0.06, 0.015, height + 0.06), accent_mat, bevel=0.005)
    rim.parent = root

    # Screen plane facing -Y (towards camera at -Y)
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0, 0.001, 0), rotation=(math.pi / 2, 0, 0))
    scr = bpy.context.active_object
    scr.name = f"{name}_Screen"
    scr.scale = (width, height, 1.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    scr_mat = make_movie_screen_mat(f"{name}_Mat", video_path, start_frame, dur_frames, strength=1.50)
    scr.data.materials.append(scr_mat)
    scr.parent = root

    # Subtle stand column down to studio floor
    if loc[2] - height * 0.5 > 0.12:
        stand_h = loc[2] - height * 0.5
        stand = make_cyl(f"{name}_Stand", (0, 0.09, -height * 0.5 - stand_h * 0.5), 0.055, stand_h, titanium_mat, bevel=0.008)
        stand.parent = root
        base = make_cyl(f"{name}_Base", (0, 0.09, -loc[2] + 0.025), 0.42, 0.05, titanium_mat, bevel=0.012)
        base.parent = root

    return root


def add_area_light(name, loc, rot_deg, energy, size_x, size_y, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, type="AREA")
    ld.energy = energy
    ld.shape = "RECTANGLE"
    ld.size = size_x
    ld.size_y = size_y
    ld.color = color
    obj = bpy.data.objects.new(name, ld)
    bpy.context.collection.objects.link(obj)
    obj.location = Vector(loc)
    obj.rotation_euler = Euler(tuple(math.radians(a) for a in rot_deg), "XYZ")
    return obj


def make_curve_conduit(name, points, radius, mat):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 8
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for i, pt in enumerate(points):
        bp = spline.bezier_points[i]
        bp.co = Vector(pt)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


# ---------------- SCENE CONSTRUCTION ----------------


def build_scene(args, timing):
    clear_scene()
    scene = bpy.context.scene
    fps = int(args.fps if args.fps is not None else timing["fps"])
    total_sec = float(timing["scenes"][-1]["endSec"])
    total_frames = int(round(total_sec * fps))

    scene.render.fps = fps
    scene.render.resolution_x = int(timing["width"])
    scene.render.resolution_y = int(timing["height"])
    scene.render.resolution_percentage = int(args.res_scale)
    scene.frame_start = 1
    scene.frame_end = total_frames

    # Color management: AgX Punchy (photorealistic filmic tone mapping!)
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Punchy"
    except Exception:
        scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.05

    # Render Engine Setup
    if args.engine == "CYCLES":
        scene.render.engine = "CYCLES"
        prefs = bpy.context.preferences.addons["cycles"].preferences
        chosen_gpu = False
        for backend in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = backend
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type == backend]
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type == backend
                    scene.cycles.device = "GPU"
                    chosen_gpu = True
                    print(f"Cycles GPU enabled via {backend}: {[g.name for g in gpus]}")
                    break
            except Exception:
                pass
        if not chosen_gpu:
            scene.cycles.device = "CPU"
        scene.cycles.samples = args.samples
        scene.cycles.use_adaptive_sampling = True
        scene.cycles.adaptive_threshold = 0.035
        scene.cycles.use_denoising = True
        try:
            scene.cycles.denoiser = "OPTIX" if chosen_gpu else "OPENIMAGEDENOISE"
        except Exception:
            scene.cycles.denoiser = "OPENIMAGEDENOISE"
        scene.cycles.max_bounces = 4
        scene.cycles.diffuse_bounces = 1
        scene.cycles.glossy_bounces = 2
        scene.cycles.transmission_bounces = 4
        scene.cycles.transparent_max_bounces = 3
        scene.cycles.sample_clamp_indirect = 8.0
        scene.cycles.use_light_tree = False
        scene.render.use_persistent_data = True
    else:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
        scene.eevee.taa_render_samples = args.samples
        try:
            scene.eevee.use_raytracing = True
            scene.eevee.raytracing_options.resolution_scale = "2"
        except Exception:
            pass

    # Subtle optical bloom/halation in Blender Compositor
    scene.use_nodes = True
    cnt = scene.node_tree
    cnt.nodes.clear()
    rl = cnt.nodes.new("CompositorNodeRLayers")
    glare = cnt.nodes.new("CompositorNodeGlare")
    glare.glare_type = "FOG_GLOW"
    glare.quality = "HIGH"
    glare.threshold = 1.15
    glare.mix = -0.35
    glare.size = 7
    comp = cnt.nodes.new("CompositorNodeComposite")
    cnt.links.new(rl.outputs["Image"], glare.inputs["Image"])
    cnt.links.new(glare.outputs["Image"], comp.inputs["Image"])

    # Dark studio world gradient
    world = bpy.data.worlds.new("StudioWorld")
    scene.world = world
    world.use_nodes = True
    wnt = world.node_tree
    wnt.nodes.clear()
    wout = wnt.nodes.new("ShaderNodeOutputWorld")
    bg = wnt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0.008, 0.012, 0.022, 1.0)
    bg.inputs["Strength"].default_value = 0.55
    wnt.links.new(bg.outputs["Background"], wout.inputs["Surface"])

    # Shared PBR Materials
    floor_mat = make_basalt_floor_mat()
    ti_dark = make_titanium_mat("TiDark", (0.09, 0.11, 0.14, 1.0), rough=0.22)
    ti_mid = make_titanium_mat("TiMid", (0.24, 0.27, 0.33, 1.0), rough=0.18)
    brass = make_brass_mat()
    silver = make_silver_title_mat()
    glass_clear, _ = make_optical_glass_mat("GlassClear", (0.86, 0.97, 0.99, 1.0), rough=0.03)
    glass_emerald, _ = make_optical_glass_mat(
        "GlassEmerald", (0.25, 0.95, 0.72, 1.0), rough=0.04, emission_col=(0.06, 0.85, 0.56, 1.0), emission_str=0.65
    )
    em_emerald, _ = make_emission_mat("EmEmerald", (0.08, 0.92, 0.60, 1.0), strength=6.5)
    em_cyan, _ = make_emission_mat("EmCyan", (0.14, 0.72, 0.98, 1.0), strength=5.5)
    em_amber, _ = make_emission_mat("EmAmber", (0.98, 0.56, 0.12, 1.0), strength=5.5)
    em_violet, _ = make_emission_mat("EmViolet", (0.56, 0.34, 0.98, 1.0), strength=5.5)
    em_white_soft, _ = make_emission_mat("EmWhiteSoft", (0.88, 0.94, 1.0, 1.0), strength=2.2)

    font_bold = r"C:\Windows\Fonts\segoeuib.ttf"
    font_mono = r"C:\Windows\Fonts\consolab.ttf"
    if not os.path.exists(font_bold):
        font_bold = None
    if not os.path.exists(font_mono):
        font_mono = None

    # Grand seamless reflective basalt studio floor spanning all 5 bays (X = -15..90)
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(38.0, 4.0, 0.0))
    floor = bpy.context.active_object
    floor.name = "StudioFloor"
    floor.scale = (140.0, 45.0, 1.0)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    floor.data.materials.append(floor_mat)

    # Subtle architectural titanium floor inlay tracks
    for y_inlay in (-3.2, 0.0, 3.2):
        make_box(f"FloorTrack_{y_inlay}", (38.0, y_inlay, 0.002), (110.0, 0.018, 0.004), ti_mid, bevel=0.0)

    # Helper to compute frame number from seconds
    def fr(sec):
        return max(1, int(round(sec * fps)) + 1)

    sc_map = {s["id"]: s for s in timing["scenes"]}
    clips_dir = os.path.join(args.out, "clips")

    # ============================================================
    # BAY 0 (X = 0): HERO MONOLITH & CLOSING LOCKUP (Scenes 1 & 6)
    # ============================================================
    add_area_light("Bay0_Key", (3.8, -5.2, 6.2), (56, 0, 32), 750, 5.5, 3.0, (1.0, 0.97, 0.92))
    add_area_light("Bay0_RimL", (-4.8, 3.4, 4.0), (62, 0, -130), 620, 4.5, 2.2, (0.35, 0.78, 1.0))
    add_area_light("Bay0_Accent", (0.0, 4.5, 1.4), (82, 0, 180), 260, 7.0, 0.6, (0.12, 0.95, 0.62))

    # Tiered machined titanium pedestal + brass precision rings
    make_cyl("Hero_Base1", (0, 0.8, 0.06), 2.35, 0.12, ti_dark, bevel=0.018)
    make_cyl("Hero_Base2", (0, 0.8, 0.15), 1.85, 0.09, ti_mid, bevel=0.014)
    make_torus("Hero_BrassRing", (0, 0.8, 0.21), 1.72, 0.028, brass)
    make_torus("Hero_EmRing", (0, 0.8, 0.20), 1.45, 0.016, em_emerald)

    # Floating optical-glass prism monolith + rotating precision gimbal rings (elevated cleanly above title!)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.88, location=(0, 1.0, 2.65))
    prism = bpy.context.active_object
    prism.name = "Hero_Prism"
    prism.scale = (0.82, 0.82, 1.18)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    add_bevel(prism, width=0.03, segments=3)
    prism.data.materials.append(glass_emerald)

    # Inner radiant photonic crystal core
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.32, location=(0, 1.0, 2.65))
    core = bpy.context.active_object
    core.name = "Hero_Core"
    core.scale = (0.68, 0.68, 1.25)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    core.data.materials.append(em_emerald)

    gimbal1 = make_torus("Hero_Gimbal1", (0, 1.0, 2.65), 1.32, 0.030, ti_mid, rot=(math.radians(65), 0, 0))
    gimbal2 = make_torus("Hero_Gimbal2", (0, 1.0, 2.65), 1.54, 0.020, brass, rot=(math.radians(115), math.radians(24), 0))
    add_area_light("Bay0_FrontFill", (0.0, -7.5, 2.2), (80, 0, 0), 190, 5.0, 2.0, (0.85, 0.94, 1.0))

    # Continuous smooth rotation across whole timeline
    for obj, ax, rate in [(prism, 2, 1.6), (core, 2, -2.4), (gimbal1, 2, 2.2), (gimbal2, 1, -1.9)]:
        set_key(obj, "rotation_euler", Euler((obj.rotation_euler[0], obj.rotation_euler[1], obj.rotation_euler[2])), 1, "LINEAR")
        e_end = list(obj.rotation_euler)
        e_end[ax] += rate * math.pi * 2
        set_key(obj, "rotation_euler", Euler(tuple(e_end)), total_frames, "LINEAR")

    # Sculpted 3D platinum title & crisp floating subtitle cleanly above pedestal (zero overlapping plates!)
    silver_cmd = make_silver_title_mat("CmdSilver", em_col=(0.45, 0.98, 0.78, 1.0), em_str=2.3)
    t_hero = make_3d_text("Hero_Title", "tslaws 1.2", (0, -1.15, 1.32), 0.74, silver, extrude=0.048, bevel=0.008, font_path=font_bold)
    t_sub = make_3d_text(
        "Hero_Sub",
        "PLAIN TYPESCRIPT  ·  MATHEMATICAL PROOFS",
        (0, -1.16, 0.86),
        0.165,
        em_white_soft,
        extrude=0.012,
        bevel=0.002,
        font_path=font_bold,
    )

    # Closing command bar (rises smoothly out of floor ONLY during Scene 6 `cta`)
    cta_start = fr(sc_map["cta"]["startSec"])
    cta_bar = bpy.data.objects.new("CTA_Lockup", None)
    bpy.context.collection.objects.link(cta_bar)
    cta_plate = make_box("CTA_Plate", (0, 0, 0), (3.85, 0.14, 0.56), ti_dark, bevel=0.035)
    cta_plate.parent = cta_bar
    cta_edge = make_box("CTA_Edge", (0, 0.02, 0), (3.89, 0.04, 0.59), em_emerald, bevel=0.01)
    cta_edge.parent = cta_bar
    cta_txt = make_3d_text("CTA_Cmd", "$ npm i -D tslaws", (0, -0.10, -0.02), 0.27, silver_cmd, extrude=0.016, bevel=0.003, font_path=font_mono)
    cta_txt.parent = cta_bar
    set_key(cta_bar, "location", Vector((0, -1.75, -1.4)), 1, "CONSTANT")
    set_key(cta_bar, "location", Vector((0, -1.75, -1.4)), cta_start - 1, "BEZIER")
    set_key(cta_bar, "location", Vector((0, -1.75, 0.44)), cta_start + 30, "BEZIER")
    # Slide title & subtitle cleanly upward in CTA so nothing overlaps!
    set_key(t_sub, "location", Vector((0, -1.16, 0.86)), cta_start - 1, "BEZIER")
    set_key(t_sub, "location", Vector((0, -1.16, 1.06)), cta_start + 28, "BEZIER")
    set_key(t_hero, "location", Vector((0, -1.15, 1.32)), cta_start - 1, "BEZIER")
    set_key(t_hero, "location", Vector((0, -1.15, 1.56)), cta_start + 28, "BEZIER")

    # ============================================================
    # BAY 1 (X = 18): REFINEMENT TYPES & VACUITY GUARD (Scene 2)
    # ============================================================
    bx1 = 18.0
    s2 = sc_map["refine"]
    s2_f0 = fr(s2["startSec"])
    s2_dur = fr(s2["endSec"]) - s2_f0 + 30

    add_area_light("Bay1_Key", (bx1 + 3.5, -5.0, 5.8), (58, 0, 28), 680, 5.0, 2.8, (1.0, 0.96, 0.90))
    add_area_light("Bay1_Rim", (bx1 - 4.8, 3.2, 3.8), (64, 0, -132), 540, 4.0, 2.0, (0.28, 0.85, 0.95))

    # Physical 3D cinema display playing REAL plain-TS refinement & vacuity check video
    make_cinema_display(
        "Disp_Refine",
        (bx1 + 0.95, 0.9, 1.85),
        (0, 0, -12),
        4.35,
        2.72,
        os.path.join(clips_dir, "clip-refine.mp4"),
        s2_f0,
        s2_dur,
        ti_dark,
        em_emerald,
    )

    # Sculpted 3D optical-glass refinement containment cylinders on left studio plinth
    make_box("Ref_Plinth", (bx1 - 2.35, 0.35, 0.12), (2.25, 1.35, 0.24), ti_dark, bevel=0.025)
    ref_specs = [
        ("nat", -0.82, 0.92, em_emerald),
        ("uint8", -0.41, 1.18, em_cyan),
        ("intRange", 0.0, 1.45, em_emerald),
        ("nonEmpty", 0.41, 1.12, em_violet),
        ("finite", 0.82, 0.86, em_amber),
    ]
    for idx, (label, dx, h, core_mat) in enumerate(ref_specs):
        cx = bx1 - 2.35 + dx
        make_cyl(f"RefCapB_{idx}", (cx, 0.35, 0.28), 0.15, 0.08, brass, bevel=0.008)
        make_cyl(f"RefGlass_{idx}", (cx, 0.35, 0.32 + h * 0.5), 0.135, h, glass_clear, bevel=0.01)
        make_cyl(f"RefCore_{idx}", (cx, 0.35, 0.32 + h * 0.48), 0.055, h * 0.84, core_mat, bevel=0.006)
        make_cyl(f"RefCapT_{idx}", (cx, 0.35, 0.36 + h), 0.15, 0.08, ti_mid, bevel=0.008)

    # Faceted amber vacuity shield crystal floating above plinth, pulsing when narrator calls out vacuous assume()
    vac_mat, vac_bsdf = make_optical_glass_mat("VacShieldMat", (1.0, 0.45, 0.15, 1.0), rough=0.05, emission_col=(1.0, 0.32, 0.08, 1.0), emission_str=0.4)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.38, location=(bx1 - 2.35, -0.35, 2.35))
    vac_obj = bpy.context.active_object
    vac_obj.name = "Vacuity_Crystal"
    vac_obj.data.materials.append(vac_mat)
    vac_t_on = fr(s2["startSec"] + 8.5)
    set_input_key(vac_bsdf, "Emission Strength", 0.35, s2_f0)
    set_input_key(vac_bsdf, "Emission Strength", 5.8, vac_t_on + 12)
    set_input_key(vac_bsdf, "Emission Strength", 2.2, vac_t_on + 45)
    make_3d_text("Bay1_Label", "REFINEMENT TYPES & VACUITY GUARD", (bx1 - 0.5, 0.9, 3.55), 0.20, em_white_soft, extrude=0.014, bevel=0.002, font_path=font_bold)

    # ============================================================
    # BAY 2 (X = 36): INDUCTION STAIRCASE & PROOFS DISPLAY (Scene 3)
    # ============================================================
    bx2 = 36.0
    s3 = sc_map["proofs"]
    s3_f0 = fr(s3["startSec"])
    s3_dur = fr(s3["endSec"]) - s3_f0 + 30

    add_area_light("Bay2_Key", (bx2 + 3.2, -5.2, 6.0), (56, 0, 26), 680, 5.2, 2.8, (1.0, 0.96, 0.91))
    add_area_light("Bay2_Rim", (bx2 - 5.2, 3.0, 4.2), (62, 0, -125), 560, 4.4, 2.2, (0.45, 0.55, 1.0))

    # Physical 3D display playing REAL plain-TS induction, calc, contracts & unreachable check video
    make_cinema_display(
        "Disp_Proofs",
        (bx2 + 1.05, 0.95, 1.85),
        (0, 0, -14),
        4.35,
        2.72,
        os.path.join(clips_dir, "clip-proofs.mp4"),
        s3_f0,
        s3_dur,
        ti_dark,
        em_violet,
    )

    # Sweeping 3D ascending optical-glass induction staircase (k = 0 .. 11) with cascading emission wave!
    cascade_start = fr(s3["startSec"] + 1.8)
    for k in range(12):
        angle = -0.55 + k * 0.16
        r_arc = 2.05
        px = bx2 - 2.35 + math.sin(angle) * 0.95 - k * 0.08
        py = -0.35 + k * 0.24
        pz = 0.22 + k * 0.24
        step_mat, step_bsdf = make_optical_glass_mat(
            f"IndStep_{k}",
            (0.62, 0.96, 0.88, 1.0),
            rough=0.04,
            emission_col=(0.10, 0.94, 0.62, 1.0) if k > 0 else (0.98, 0.76, 0.22, 1.0),
            emission_str=0.15,
        )
        block = make_box(
            f"IndBlock_{k}",
            (px, py, pz),
            (0.68, 0.22, 0.14),
            step_mat,
            rot=(0, 0, math.radians(-18 + k * 5)),
            bevel=0.018,
        )
        # Thin brass rail trim underneath each crystal step
        make_box(
            f"IndRail_{k}",
            (px, py, pz - 0.082),
            (0.64, 0.16, 0.022),
            brass,
            rot=(0, 0, math.radians(-18 + k * 5)),
            bevel=0.004,
        )
        # Keyframe luminous cascade wave: k=0 ignites first, propagating k -> k+1!
        t_hit = cascade_start + k * 7
        set_input_key(step_bsdf, "Emission Strength", 0.12, max(1, t_hit - 6))
        set_input_key(step_bsdf, "Emission Strength", 4.6 if k == 0 else 3.2, t_hit + 5)
        set_input_key(step_bsdf, "Emission Strength", 1.35, t_hit + 24)

    make_3d_text("Bay2_Label", "INDUCTION  ·  CALC  ·  CONTRACTS  ·  TERMINATION", (bx2 - 0.3, 0.95, 3.55), 0.19, em_white_soft, extrude=0.014, bevel=0.002, font_path=font_bold)

    # ============================================================
    # BAY 3 (X = 54): PANORAMIC 3-SCREEN REAL BROWSER RIG (Scene 4)
    # ============================================================
    bx3 = 54.0
    s4 = sc_map["browser"]
    s4_f0 = fr(s4["startSec"])
    s4_dur = fr(s4["endSec"]) - s4_f0 + 30

    add_area_light("Bay3_Key", (bx3, -5.8, 6.2), (55, 0, 0), 650, 7.5, 2.5, (0.95, 0.97, 1.0))
    add_area_light("Bay3_Rim", (bx3, 4.5, 3.8), (68, 0, 180), 480, 9.0, 1.5, (0.16, 0.85, 0.72))

    # 3 curved-arc floating physical 3D displays playing 3 LIVE Chromium browser recordings simultaneously!
    make_cinema_display(
        "Disp_Browser1",
        (bx3 - 3.65, 0.55, 1.92),
        (0, 0, 24),
        3.55,
        2.22,
        os.path.join(clips_dir, "clip-browser-1.mp4"),
        s4_f0,
        s4_dur,
        ti_dark,
        em_emerald,
    )
    make_cinema_display(
        "Disp_Browser2",
        (bx3, 1.38, 1.92),
        (0, 0, 0),
        3.55,
        2.22,
        os.path.join(clips_dir, "clip-browser-2.mp4"),
        s4_f0,
        s4_dur,
        ti_dark,
        em_violet,
    )
    make_cinema_display(
        "Disp_Browser3",
        (bx3 + 3.65, 0.55, 1.92),
        (0, 0, -24),
        3.55,
        2.22,
        os.path.join(clips_dir, "clip-browser-3.mp4"),
        s4_f0,
        s4_dur,
        ti_dark,
        em_amber,
    )

    # Physical optical-glass local-origin hub puck on floor + 3 glowing fiber-optic conduits to the 3 screens!
    make_cyl("Hub_Base", (bx3, -0.75, 0.08), 0.78, 0.16, ti_dark, bevel=0.018)
    make_cyl("Hub_Glass", (bx3, -0.75, 0.22), 0.58, 0.14, glass_emerald, bevel=0.014)
    make_torus("Hub_Ring", (bx3, -0.75, 0.18), 0.66, 0.022, em_cyan)
    make_curve_conduit("Conduit_L", [(bx3 - 0.45, -0.75, 0.18), (bx3 - 2.1, -0.35, 0.28), (bx3 - 3.65, 0.55, 0.80)], 0.024, em_emerald)
    make_curve_conduit("Conduit_C", [(bx3, -0.25, 0.18), (bx3, 0.55, 0.35), (bx3, 1.38, 0.80)], 0.024, em_violet)
    make_curve_conduit("Conduit_R", [(bx3 + 0.45, -0.75, 0.18), (bx3 + 2.1, -0.35, 0.28), (bx3 + 3.65, 0.55, 0.80)], 0.024, em_amber)

    make_3d_text("Bay3_Label", "PARALLEL REAL BROWSER CONTEXTS", (bx3, 1.35, 3.45), 0.22, em_white_soft, extrude=0.014, bevel=0.002, font_path=font_bold)

    # ============================================================
    # BAY 4 (X = 72): 8-CORE POOLED Z3 ENGINE & CACHE BENCHMARK (Scene 5)
    # ============================================================
    bx4 = 72.0
    s5 = sc_map["speed"]
    s5_f0 = fr(s5["startSec"])
    s5_dur = fr(s5["endSec"]) - s5_f0 + 30

    add_area_light("Bay4_Key", (bx4 + 3.5, -5.0, 5.8), (56, 0, 28), 680, 5.0, 2.8, (0.94, 0.98, 1.0))
    add_area_light("Bay4_Rim", (bx4 - 4.8, 3.2, 4.0), (62, 0, -128), 540, 4.2, 2.0, (0.14, 0.92, 0.65))

    make_cinema_display(
        "Disp_Speed",
        (bx4 + 1.15, 0.9, 1.85),
        (0, 0, -12),
        4.35,
        2.72,
        os.path.join(clips_dir, "clip-speed.mp4"),
        s5_f0,
        s5_dur,
        ti_dark,
        em_cyan,
    )

    # Radial 8-core optical Z3 processor + central hovering emerald Proof Cache Cube
    cx4, cy4 = bx4 - 2.05, 0.45
    make_cyl("Z3_Deck", (cx4, cy4, 0.10), 1.38, 0.20, ti_dark, bevel=0.022)
    make_torus("Z3_DeckRing", (cx4, cy4, 0.21), 1.24, 0.022, brass)
    for c in range(8):
        ang = c * (math.pi * 2 / 8)
        px = cx4 + math.cos(ang) * 1.02
        py = cy4 + math.sin(ang) * 1.02
        make_cyl(f"Z3CoreGlass_{c}", (px, py, 0.78), 0.125, 1.15, glass_clear, bevel=0.012)
        make_cyl(f"Z3CoreRod_{c}", (px, py, 0.78), 0.048, 1.02, em_cyan if c % 2 == 0 else em_emerald, bevel=0.005)
        make_cyl(f"Z3CoreCap_{c}", (px, py, 1.39), 0.145, 0.07, ti_mid, bevel=0.008)

    # Central hovering Proof Cache Cube floating prominently above the 8 Z3 pillars
    cache_cube = make_box("ProofCacheCube", (cx4, cy4, 2.05), (0.76, 0.76, 0.76), glass_emerald, rot=(0.45, 0.55, 0.2), bevel=0.05)
    cache_inner = make_box("ProofCacheInner", (cx4, cy4, 2.05), (0.36, 0.36, 0.36), em_emerald, rot=(0.45, 0.55, 0.2), bevel=0.02)
    for obj, spd in [(cache_cube, 2.2), (cache_inner, -3.5)]:
        set_key(obj, "rotation_euler", Euler((0.45, 0.55, 0.2)), s5_f0, "LINEAR")
        set_key(obj, "rotation_euler", Euler((0.45 + spd, 0.55 + spd * 0.7, 0.2 + spd * 1.4)), s5_f0 + s5_dur, "LINEAR")

    make_3d_text("Bay4_Label", "POOLED NATIVE Z3  ·  PROOF CACHE", (bx4 - 0.3, 0.9, 3.55), 0.20, em_white_soft, extrude=0.014, bevel=0.002, font_path=font_bold)

    # ============================================================
    # CINEMA CAMERA + FOCUS TARGET RIG (Smooth Dolly, Arc & Rack Focus)
    # ============================================================
    cam_target = bpy.data.objects.new("CamTarget", None)
    bpy.context.collection.objects.link(cam_target)

    cam_data = bpy.data.cameras.new("CinemaCam")
    cam_data.lens = 30.0
    cam_data.sensor_width = 36.0
    cam_data.dof.use_dof = True
    cam_data.dof.focus_object = cam_target
    cam_data.dof.aperture_fstop = 5.6  # sharp displays + lush background bokeh!
    cam_obj = bpy.data.objects.new("CinemaCam", cam_data)
    bpy.context.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    track = cam_obj.constraints.new("TRACK_TO")
    track.target = cam_target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    # Helper: keyframe a clean cut between bays (CONSTANT on the cut-in frame, BEZIER within each shot!)
    def add_shot(s_id, cam_keys, tgt_keys):
        sc = sc_map[s_id]
        f_start = fr(sc["startSec"])
        f_end = fr(sc["endSec"])
        for idx, (frac, pos) in enumerate(cam_keys):
            f = f_start if idx == 0 else (f_end - 1 if idx == len(cam_keys) - 1 else int(round(f_start + frac * (f_end - f_start))))
            interp = "BEZIER" if idx < len(cam_keys) - 1 else "CONSTANT"
            set_key(cam_obj, "location", Vector(pos), f, interp)
        for idx, (frac, pos) in enumerate(tgt_keys):
            f = f_start if idx == 0 else (f_end - 1 if idx == len(tgt_keys) - 1 else int(round(f_start + frac * (f_end - f_start))))
            interp = "BEZIER" if idx < len(tgt_keys) - 1 else "CONSTANT"
            set_key(cam_target, "location", Vector(pos), f, interp)

    # Shot 1: Hero — sweeping wide arc around Proof Prism Monolith & 3D platinum title (full monolith + pedestal visible!)
    add_shot(
        "hero",
        [(0.0, (-3.6, -7.2, 1.55)), (0.55, (0.2, -6.8, 1.95)), (1.0, (2.4, -6.5, 2.05))],
        [(0.0, (0.0, 0.3, 1.75)), (0.55, (0.0, 0.2, 1.75)), (1.0, (0.0, 0.2, 1.72))],
    )
    # Shot 2: Refine — wide studio dolly framing all 5 glass vials + vacuity crystal AND the entire plain-TS display!
    add_shot(
        "refine",
        [(0.0, (bx1 - 2.6, -6.9, 1.95)), (0.50, (bx1 - 0.5, -6.2, 1.95)), (1.0, (bx1 + 0.5, -5.6, 1.90))],
        [(0.0, (bx1 - 0.4, 0.75, 1.85)), (0.50, (bx1 - 0.05, 0.85, 1.88)), (1.0, (bx1 + 0.35, 0.9, 1.88))],
    )
    # Shot 3: Proofs — sweeping dolly showcasing entire glowing crystal induction staircase + full live proof display!
    add_shot(
        "proofs",
        [(0.0, (bx2 - 3.6, -6.8, 1.85)), (0.48, (bx2 - 0.6, -6.3, 2.02)), (1.0, (bx2 + 0.5, -5.6, 1.92))],
        [(0.0, (bx2 - 0.7, 0.7, 1.75)), (0.48, (bx2 - 0.05, 0.85, 1.85)), (1.0, (bx2 + 0.45, 0.95, 1.88))],
    )
    # Shot 4: Browser — smooth panoramic sweep across all 3 LIVE Chromium screens -> full 3-screen + hub wide reveal!
    add_shot(
        "browser",
        [
            (0.0, (bx3 - 4.4, -5.8, 1.92)),
            (0.32, (bx3 - 0.3, -6.2, 2.00)),
            (0.62, (bx3 + 4.0, -5.8, 1.95)),
            (1.0, (bx3, -9.4, 2.35)),
        ],
        [
            (0.0, (bx3 - 2.8, 0.65, 1.88)),
            (0.32, (bx3, 1.25, 1.90)),
            (0.62, (bx3 + 2.8, 0.65, 1.88)),
            (1.0, (bx3, 0.95, 1.82)),
        ],
    )
    # Shot 5: Speed — framing full 8-core optical Z3 processor + Proof Cache Cube alongside full cache benchmark screen!
    add_shot(
        "speed",
        [(0.0, (bx4 - 3.4, -6.5, 2.08)), (0.50, (bx4 - 0.5, -6.1, 1.95)), (1.0, (bx4 + 0.5, -5.5, 1.90))],
        [(0.0, (bx4 - 0.8, 0.65, 1.65)), (0.50, (bx4 - 0.1, 0.8, 1.82)), (1.0, (bx4 + 0.45, 0.9, 1.88))],
    )
    # Shot 6: CTA — majestic pull-back revealing glowing prism monolith + `tslaws 1.2` + `$ npm i -D tslaws` cleanly stacked!
    add_shot(
        "cta",
        [(0.0, (-1.2, -6.6, 1.72)), (1.0, (0.0, -7.8, 1.95))],
        [(0.0, (0.0, -0.2, 1.62)), (1.0, (0.0, -0.2, 1.58))],
    )

    return scene, total_frames, sc_map, fr


def main():
    args = parse_args()
    with open(args.timing, "r", encoding="utf-8") as f:
        timing = json.load(f)

    scene, total_frames, sc_map, fr = build_scene(args, timing)
    os.makedirs(args.out, exist_ok=True)

    # Save .blend file from worker 1 / preview mode so parallel workers never race on disk
    if args.mode == "preview" or args.start is None or args.start == 1:
        blend_path = os.path.join(args.out, "tslaws-1.2-studio.blend")
        bpy.ops.wm.save_as_mainfile(filepath=blend_path)
        print(f"Saved Blender project: {blend_path}")

    if args.mode == "preview":
        stills_dir = os.path.join(args.out, "stills")
        os.makedirs(stills_dir, exist_ok=True)
        scene.render.image_settings.file_format = "JPEG"
        scene.render.image_settings.quality = 92
        picks = [
            ("s1-hero", fr(sc_map["hero"]["startSec"] + 4.5)),
            ("s2-refine", fr(sc_map["refine"]["startSec"] + 10.0)),
            ("s3-proofs", fr(sc_map["proofs"]["startSec"] + 8.5)),
            ("s4-browser", fr(sc_map["browser"]["startSec"] + 11.5)),
            ("s5-speed", fr(sc_map["speed"]["startSec"] + 7.0)),
            ("s6-cta", fr(sc_map["cta"]["startSec"] + 5.5)),
        ]
        for name, frame_num in picks:
            t0 = time.time()
            scene.frame_set(frame_num)
            out_path = os.path.join(stills_dir, f"{name}.jpg")
            scene.render.filepath = out_path
            bpy.ops.render.render(write_still=True)
            print(f"Preview {name} (frame {frame_num}) rendered in {time.time() - t0:.2f}s -> {out_path}")
    else:
        frames_dir = os.path.join(args.out, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        scene.render.image_settings.file_format = "JPEG"
        scene.render.image_settings.color_mode = "RGB"
        scene.render.image_settings.quality = 96
        f_start = args.start if args.start is not None else 1
        f_end = args.end if args.end is not None else total_frames
        scene.frame_start = f_start
        scene.frame_end = f_end
        scene.render.filepath = os.path.join(frames_dir, "frame_")
        t0 = time.time()
        bpy.ops.render.render(animation=True)
        print(f"Rendered frames {f_start}..{f_end} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
