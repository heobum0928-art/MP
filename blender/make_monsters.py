"""
몬스터 스프라이트 생성기 (Blender 헤드리스 실행)

  blender -b --factory-startup -P blender/make_monsters.py -- [출력폴더] [엔진]

  엔진: EEVEE(기본) | CYCLES
출력: <출력폴더>/<몬스터>_<프레임>.png  +  manifest.json
"""
import bpy, math, json, os, sys
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else os.path.join(os.path.dirname(__file__), "..", "assets", "monsters"))
ENGINE = (argv[1] if len(argv) > 1 else "EEVEE").upper()
RES = 256   # 폰 메모리 한도(iOS 캔버스) 고려
os.makedirs(OUT, exist_ok=True)

# ─────────────── 씬 초기화 ───────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.resolution_x = RES
scene.render.resolution_y = RES
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"   # 만화풍: 채도 유지

if ENGINE == "CYCLES":
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
else:
    for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = e
            break
        except TypeError:
            continue
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass

world = bpy.data.worlds.new("W")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.32, 0.36, 0.48, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9


def srgb(h):
    """'#rrggbb' → 선형 RGBA"""
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c) + (1.0,)


def set_in(bsdf, names, value):
    for n in names:
        if n in bsdf.inputs:
            bsdf.inputs[n].default_value = value
            return


def mat(name, color, rough=0.35, sss=0.0, emit=0.0, spec=0.5, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = srgb(color)
    b.inputs["Roughness"].default_value = rough
    set_in(b, ["Subsurface Weight", "Subsurface"], sss)
    set_in(b, ["Subsurface Radius"], (0.6, 0.3, 0.2))
    set_in(b, ["Specular IOR Level", "Specular"], spec)
    set_in(b, ["Coat Weight", "Clearcoat"], coat)
    if emit:
        set_in(b, ["Emission Color", "Emission"], srgb(color))
        set_in(b, ["Emission Strength"], emit)
    return m


# 공용 재질
M_EYE_WHITE = mat("eye_white", "#fbfbff", rough=0.12, coat=1.0)
M_PUPIL = mat("pupil", "#0b0d18", rough=0.08, coat=1.0)
M_SHINE = mat("shine", "#ffffff", emit=6.0)
M_MOUTH = mat("mouth", "#2a0d1a", rough=0.6)
M_TOOTH = mat("tooth", "#fff8e8", rough=0.25)
M_TONGUE = mat("tongue", "#ff5c8a", rough=0.4, sss=0.3)
M_BLUSH = mat("blush", "#ff8fb0", rough=0.6)


# ─────────────── 도형 헬퍼 ───────────────
def sphere(name, loc, scale, material, parent, seg=48):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, radius=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    o.parent = parent
    return o


def cone(name, loc, rot, r1, depth, material, parent, r2=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=r1, radius2=r2, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    o.parent = parent
    return o


def torus(name, loc, rot, major, minor, material, parent):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, location=loc, rotation=rot,
                                     major_segments=48, minor_segments=16)
    o = bpy.context.active_object
    o.name = name
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    o.parent = parent
    return o


EXTRA = {}          # 몬스터별: hurt_hide(맞으면 숨김) / hurt_show(맞으면 보임)
CUR = {"name": None}


def root(name):
    o = bpy.data.objects.new(name, None)
    scene.collection.objects.link(o)
    CUR["name"] = name
    EXTRA[name] = {"hurt_hide": [], "hurt_show": []}
    return o


M_XEYE = None   # 아래에서 생성


def eye(prefix, x, z, r, y_front, parent, lids):
    """눈 한 쌍 중 하나. 깜빡임 프레임용 눈꺼풀(lids 리스트에 등록)."""
    sphere(f"{prefix}_white", (x, y_front, z), (r, r * 0.7, r * 1.12), M_EYE_WHITE, parent)
    pu = sphere(f"{prefix}_pupil", (x * 0.94, y_front - r * 0.52, z - r * 0.08), (r * 0.52, r * 0.3, r * 0.6), M_PUPIL, parent)
    sh = sphere(f"{prefix}_shine", (x * 0.94 - r * 0.2, y_front - r * 0.78, z + r * 0.22), (r * 0.16,) * 3, M_SHINE, parent, seg=16)
    ex = EXTRA[CUR["name"]]
    ex["hurt_hide"] += [pu, sh]
    # 맞았을 때 X 눈 (평소엔 숨김)
    for a in (math.pi / 4, -math.pi / 4):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y_front - r * 0.72, z), rotation=(0, a, 0))
        xb = bpy.context.active_object
        xb.name = f"{prefix}_xeye"
        xb.scale = (r * 1.25, r * 0.12, r * 0.22)
        xb.data.materials.append(M_PUPIL)
        xb.parent = parent
        xb.hide_render = True
        ex["hurt_show"].append(xb)
    # 감은 눈: 피부색 덮개가 흰자·동공을 덮고, 그 앞에 어두운 감은눈 선
    lids.append(sphere(f"{prefix}_lid", (x, y_front - r * 0.12, z), (r * 1.1, r * 0.84, r * 1.18), parent.get("skin"), parent))
    lids.append(sphere(f"{prefix}_lidline", (x, y_front - r * 0.9, z - r * 0.1), (r * 0.78, r * 0.08, r * 0.09), M_PUPIL, parent, seg=24))


# 몬스터별: 본체 반지름(=게임 히트박스 기준) 정보 수집
MONSTERS = {}


def build_slime():
    R = root("slime")
    skin = mat("slime_skin", "#46e08a", rough=0.18, sss=0.35, coat=0.6)
    R["skin"] = skin
    body = sphere("slime_body", (0, 0, 0), (1.0, 0.92, 0.86), skin, R)
    sphere("slime_drip_l", (-0.78, -0.1, -0.62), (0.28, 0.28, 0.22), skin, R)
    sphere("slime_drip_r", (0.7, -0.2, -0.66), (0.22, 0.22, 0.18), skin, R)
    sphere("slime_top", (0.1, 0, 0.78), (0.3, 0.3, 0.26), skin, R)
    lids = []
    eye("slime_eyeL", -0.36, 0.18, 0.24, -0.72, R, lids)
    eye("slime_eyeR", 0.36, 0.18, 0.24, -0.72, R, lids)
    sphere("slime_mouth", (0, -0.8, -0.28), (0.26, 0.1, 0.14), M_MOUTH, R)
    sphere("slime_tongue", (0.04, -0.86, -0.34), (0.12, 0.06, 0.06), M_TONGUE, R, seg=24)
    MONSTERS["slime"] = dict(root=R, lids=lids, body_r=1.0, ortho=3.0, z_off=0.0)


def build_bat():
    R = root("bat")
    skin = mat("bat_skin", "#8a5cff", rough=0.3, sss=0.15, coat=0.4)
    wing = mat("bat_wing", "#4b2a9e", rough=0.5, sss=0.2)
    R["skin"] = skin
    sphere("bat_body", (0, 0, 0), (0.86, 0.8, 0.86), skin, R)
    for s in (-1, 1):
        w = sphere(f"bat_wing{s}", (s * 1.12, 0.12, 0.12), (0.66, 0.08, 0.42), wing, R)
        w.rotation_euler = (0, s * -0.42, 0)
        w2 = sphere(f"bat_wingtip{s}", (s * 1.5, 0.14, 0.42), (0.34, 0.07, 0.24), wing, R)
        w2.rotation_euler = (0, s * -0.9, 0)
        cone(f"bat_ear{s}", (s * 0.44, 0.05, 0.84), (0, s * 0.35, 0), 0.2, 0.46, skin, R)
    lids = []
    eye("bat_eye", 0.0, 0.14, 0.36, -0.6, R, lids)   # 외눈
    sphere("bat_mouth", (0, -0.72, -0.36), (0.3, 0.08, 0.1), M_MOUTH, R)
    for s in (-1, 1):
        cone(f"bat_fang{s}", (s * 0.14, -0.78, -0.44), (math.pi, 0, 0), 0.06, 0.16, M_TOOTH, R)
    MONSTERS["bat"] = dict(root=R, lids=lids, body_r=0.86, ortho=3.6, z_off=0.1)


def build_horn():
    R = root("horn")
    skin = mat("horn_skin", "#ff8a3d", rough=0.4, sss=0.12)
    belly = mat("horn_belly", "#ffd29a", rough=0.5)
    hornm = mat("horn_horn", "#f3ead8", rough=0.3, coat=0.5)
    R["skin"] = skin
    sphere("horn_body", (0, 0, 0), (1.0, 0.9, 0.94), skin, R)
    sphere("horn_belly", (0, -0.52, -0.3), (0.62, 0.45, 0.5), belly, R)
    for s in (-1, 1):
        cone(f"horn_horn{s}", (s * 0.52, 0, 0.9), (0, s * 0.45, 0), 0.2, 0.62, hornm, R)
        sphere(f"horn_arm{s}", (s * 1.0, -0.1, -0.3), (0.26, 0.26, 0.3), skin, R)
        sphere(f"horn_foot{s}", (s * 0.44, -0.2, -0.92), (0.3, 0.34, 0.16), skin, R)
    lids = []
    eye("horn_eyeL", -0.33, 0.28, 0.2, -0.76, R, lids)
    eye("horn_eyeR", 0.33, 0.28, 0.2, -0.76, R, lids)
    sphere("horn_mouth", (0, -0.86, -0.08), (0.36, 0.1, 0.16), M_MOUTH, R)
    for i, x in enumerate((-0.22, -0.08, 0.08, 0.22)):
        cone(f"horn_tooth{i}", (x, -0.92, 0.02), (math.pi, 0, 0), 0.055, 0.14, M_TOOTH, R)
    MONSTERS["horn"] = dict(root=R, lids=lids, body_r=1.0, ortho=3.1, z_off=0.05)


def build_boss():
    R = root("boss")
    skin = mat("boss_skin", "#e0314f", rough=0.35, sss=0.1, coat=0.3)
    dark = mat("boss_dark", "#5b0f22", rough=0.5)
    gold = mat("boss_gold", "#ffc53d", rough=0.18, spec=0.9, coat=1.0)
    R["skin"] = skin
    sphere("boss_body", (0, 0, 0), (1.0, 0.9, 0.92), skin, R)
    sphere("boss_jaw", (0, -0.35, -0.5), (0.8, 0.6, 0.42), skin, R)
    for s in (-1, 1):
        h = cone(f"boss_horn{s}", (s * 0.7, 0.05, 0.86), (0, s * 0.75, 0), 0.24, 0.9, dark, R)
        cone(f"boss_hornTip{s}", (s * 1.02, 0.05, 1.2), (0, s * 1.2, 0), 0.1, 0.3, gold, R)
        sphere(f"boss_brow{s}", (s * 0.34, -0.74, 0.5), (0.3, 0.1, 0.08), dark, R).rotation_euler = (0, s * -0.4, 0)
        sphere(f"boss_fist{s}", (s * 1.08, -0.2, -0.36), (0.36, 0.36, 0.36), skin, R)
    # 왕관
    torus("boss_crown_band", (0, 0, 0.84), (0, 0, 0), 0.4, 0.07, gold, R)
    for i in range(5):
        a = i / 5 * math.tau
        cone(f"boss_crown{i}", (math.cos(a) * 0.4, math.sin(a) * 0.4, 1.02), (0, 0, 0), 0.08, 0.3, gold, R)
    sphere("boss_gem", (0, -0.44, 0.88), (0.08, 0.05, 0.1), mat("gem", "#3dd6ff", rough=0.05, emit=2.0), R, seg=24)
    lids = []
    eye("boss_eyeL", -0.34, 0.26, 0.2, -0.76, R, lids)
    eye("boss_eyeR", 0.34, 0.26, 0.2, -0.76, R, lids)
    sphere("boss_mouth", (0, -0.88, -0.34), (0.5, 0.12, 0.2), M_MOUTH, R)
    for i in range(6):
        x = -0.36 + i * 0.144
        cone(f"boss_toothU{i}", (x, -0.96, -0.2), (math.pi, 0, 0), 0.06, 0.18, M_TOOTH, R)
    for s in (-1, 1):
        cone(f"boss_tusk{s}", (s * 0.36, -0.94, -0.46), (0, 0, 0), 0.08, 0.3, M_TOOTH, R)
    MONSTERS["boss"] = dict(root=R, lids=lids, body_r=1.0, ortho=3.5, z_off=0.1)


M_GOLD = mat("gold", "#ffc53d", rough=0.18, spec=0.9, coat=1.0)
M_COAL = mat("coal", "#15161c", rough=0.3, coat=0.8)


def crown(prefix, z, radius, parent, points=5, gem="#3dd6ff"):
    torus(f"{prefix}_band", (0, 0, z), (0, 0, 0), radius, radius * 0.17, M_GOLD, parent)
    for i in range(points):
        a = i / points * math.tau + math.pi / 2
        cone(f"{prefix}_pt{i}", (math.cos(a) * radius, math.sin(a) * radius, z + radius * 0.45), (0, 0, 0),
             radius * 0.2, radius * 0.75, M_GOLD, parent)
    sphere(f"{prefix}_gem", (0, -radius * 1.05, z + radius * 0.1), (radius * 0.2, radius * 0.12, radius * 0.24),
           mat(f"{prefix}_gemm", gem, rough=0.05, emit=2.0), parent, seg=24)


def on_ellipsoid(sx, sy, sz, theta, phi, cz=0.0):
    """타원체 표면 좌표 (theta: 방위각, phi: 위도 -pi/2~pi/2)"""
    return (sx * math.cos(phi) * math.cos(theta), sy * math.cos(phi) * math.sin(theta), cz + sz * math.sin(phi))


# ── 일반 몬스터 ──
def build_ghost():
    R = root("ghost")
    skin = mat("ghost_skin", "#e9f0ff", rough=0.25, sss=0.5, emit=0.25, coat=0.4)
    R["skin"] = skin
    sphere("ghost_body", (0, 0, 0.1), (0.9, 0.82, 0.95), skin, R)
    for i, (x, z, r) in enumerate([(-0.55, -0.72, 0.34), (0.0, -0.84, 0.36), (0.55, -0.72, 0.34)]):
        sphere(f"ghost_tail{i}", (x, 0, z), (r, r * 0.9, r * 1.1), skin, R)
    for s in (-1, 1):
        sphere(f"ghost_arm{s}", (s * 0.9, -0.1, -0.05), (0.28, 0.22, 0.2), skin, R).rotation_euler = (0, s * 0.6, 0)
        sphere(f"ghost_cheek{s}", (s * 0.46, -0.72, -0.12), (0.12, 0.04, 0.08), mat(f"ghost_blush{s}", "#ff9ab8"), R, seg=24)
    lids = []
    eye("ghost_eyeL", -0.3, 0.28, 0.2, -0.7, R, lids)
    eye("ghost_eyeR", 0.3, 0.28, 0.2, -0.7, R, lids)
    torus("ghost_mouth", (0, -0.8, -0.14), (math.pi / 2, 0, 0), 0.1, 0.04, M_MOUTH, R)
    MONSTERS["ghost"] = dict(root=R, lids=lids, body_r=0.95, ortho=3.1, z_off=0.0)


def build_mushroom():
    R = root("mushroom")
    cap = mat("mush_cap", "#ff4b4b", rough=0.3, sss=0.1, coat=0.5)
    dot = mat("mush_dot", "#fff6e6", rough=0.4)
    stem = mat("mush_stem", "#ffe9c7", rough=0.5, sss=0.2)
    R["skin"] = stem
    sphere("mush_cap", (0, 0, 0.3), (1.15, 1.05, 0.66), cap, R)
    for i, (th, ph) in enumerate([(-1.9, 0.5), (-1.25, 0.75), (-0.6, 0.45), (-2.5, 0.35), (-1.57, 1.2), (-0.2, 0.15), (-2.95, 0.15)]):
        x, y, z = on_ellipsoid(1.15, 1.05, 0.66, th, ph, cz=0.3)
        sphere(f"mush_dot{i}", (x, y, z), (0.16, 0.16, 0.08), dot, R, seg=24).rotation_euler = (math.pi / 2 - ph, 0, th + math.pi / 2)
    sphere("mush_stem", (0, 0, -0.42), (0.62, 0.56, 0.58), stem, R)
    for s in (-1, 1):
        sphere(f"mush_foot{s}", (s * 0.34, -0.1, -0.96), (0.22, 0.26, 0.12), stem, R)
    lids = []
    eye("mush_eyeL", -0.22, -0.3, 0.14, -0.52, R, lids)
    eye("mush_eyeR", 0.22, -0.3, 0.14, -0.52, R, lids)
    sphere("mush_mouth", (0, -0.56, -0.62), (0.12, 0.05, 0.07), M_MOUTH, R, seg=24)
    MONSTERS["mushroom"] = dict(root=R, lids=lids, body_r=1.0, ortho=3.0, z_off=0.0)


def build_bee():
    R = root("bee")
    skin = mat("bee_skin", "#ffcf2e", rough=0.3, sss=0.1, coat=0.5)
    black = mat("bee_black", "#1d1a22", rough=0.4)
    wing = mat("bee_wing", "#cfeeff", rough=0.05, emit=0.4, coat=1.0)
    R["skin"] = skin
    sx, sz = 0.82, 0.8
    sphere("bee_body", (0, 0, 0), (sx, 0.78, sz), skin, R)
    for i, z in enumerate((-0.2, -0.5)):
        rr = sx * math.sqrt(max(0.0, 1 - (z / sz) ** 2))
        torus(f"bee_stripe{i}", (0, 0, z), (0, 0, 0), rr * 0.97, 0.075, black, R)
    cone("bee_sting", (0, 0.1, -0.9), (math.pi, 0, 0), 0.12, 0.3, black, R)
    for s in (-1, 1):
        w = sphere(f"bee_wing{s}", (s * 0.7, 0.3, 0.65), (0.5, 0.06, 0.3), wing, R)
        w.rotation_euler = (0, s * -0.7, 0)
        cone(f"bee_ant{s}", (s * 0.25, -0.1, 0.95), (0, s * 0.35, 0), 0.03, 0.4, black, R, r2=0.03)
        sphere(f"bee_antball{s}", (s * 0.33, -0.1, 1.14), (0.08,) * 3, black, R, seg=16)
    lids = []
    eye("bee_eyeL", -0.28, 0.22, 0.19, -0.66, R, lids)
    eye("bee_eyeR", 0.28, 0.22, 0.19, -0.66, R, lids)
    sphere("bee_mouth", (0, -0.76, -0.02), (0.14, 0.05, 0.06), M_MOUTH, R, seg=24)
    MONSTERS["bee"] = dict(root=R, lids=lids, body_r=0.82, ortho=3.0, z_off=0.1)


def build_golem():
    R = root("golem")
    rock = mat("golem_rock", "#8d8f99", rough=0.85)
    rock2 = mat("golem_rock2", "#6c6e78", rough=0.9)
    moss = mat("golem_moss", "#5dbb4a", rough=0.8)
    glow = mat("golem_glow", "#57e4ff", emit=5.0)
    R["skin"] = rock
    sphere("golem_body", (0, 0, 0), (1.0, 0.9, 0.95), rock, R, seg=12)   # 각진 느낌: 낮은 분할
    for i, (th, ph, r) in enumerate([(-2.3, 0.3, 0.3), (-0.8, -0.3, 0.26), (-1.6, -0.6, 0.28), (-0.3, 0.5, 0.22), (-2.8, -0.2, 0.24)]):
        sphere(f"golem_chunk{i}", on_ellipsoid(1.0, 0.9, 0.95, th, ph), (r, r * 0.8, r * 0.9), rock2, R, seg=8)
    sphere("golem_moss", (0.1, -0.05, 0.82), (0.6, 0.5, 0.2), moss, R, seg=16)
    for s in (-1, 1):
        sphere(f"golem_fist{s}", (s * 1.15, -0.25, -0.35), (0.42, 0.42, 0.42), rock2, R, seg=10)
        sphere(f"golem_eye{s}", (s * 0.32, -0.8, 0.22), (0.13, 0.06, 0.08), glow, R, seg=16)
    sphere("golem_mouth", (0, -0.86, -0.22), (0.3, 0.06, 0.05), glow, R, seg=16)
    MONSTERS["golem"] = dict(root=R, lids=[], body_r=1.0, ortho=3.3, z_off=0.0)


def build_bomb():
    R = root("bomb")
    shell = mat("bomb_shell", "#23252f", rough=0.45, spec=0.3, coat=0.15)
    fuse = mat("bomb_fuse", "#c8a26b", rough=0.7)
    spark = mat("bomb_spark", "#ffb23d", emit=8.0)
    R["skin"] = shell
    sphere("bomb_body", (0, 0, 0), (0.9, 0.9, 0.9), shell, R)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.2, depth=0.2, location=(0, 0, 0.92))
    cap = bpy.context.active_object; cap.data.materials.append(mat("bomb_cap", "#555a6a", rough=0.3)); cap.parent = R
    cone("bomb_fuse", (0.08, 0, 1.14), (0, 0.4, 0), 0.04, 0.34, fuse, R, r2=0.04)
    sphere("bomb_spark", (0.18, 0, 1.3), (0.14,) * 3, spark, R, seg=16)
    for i in range(6):
        a = i / 6 * math.tau
        cone(f"bomb_ray{i}", (0.18 + math.cos(a) * 0.16, -0.02, 1.3 + math.sin(a) * 0.16), (0, math.pi / 2 - a, 0),
             0.03, 0.14, spark, R)
    red = mat("bomb_red", "#ff3d3d", emit=2.5)
    for s in (-1, 1):
        sphere(f"bomb_white{s}", (s * 0.3, -0.76, 0.12), (0.19, 0.08, 0.17), M_EYE_WHITE, R, seg=24)
        sphere(f"bomb_eye{s}", (s * 0.26, -0.84, 0.1), (0.09, 0.04, 0.1), M_PUPIL, R, seg=16)
        sphere(f"bomb_brow{s}", (s * 0.3, -0.86, 0.32), (0.24, 0.06, 0.06), mat(f"bomb_browm{s}", "#101116"), R, seg=16).rotation_euler = (0, s * -0.5, 0)
    torus("bomb_mouth", (0, -0.84, -0.36), (math.pi / 2, 0, 0), 0.2, 0.04, red, R)   # 찡그린 입(아래쪽 반은 몸에 묻힘)
    MONSTERS["bomb"] = dict(root=R, lids=[], body_r=0.9, ortho=3.0, z_off=0.15)


def build_imp():
    R = root("imp")
    skin = mat("imp_skin", "#ff5a2a", rough=0.35, sss=0.2, coat=0.3)
    wing = mat("imp_wing", "#7a1a12", rough=0.5)
    fire1 = mat("imp_fire1", "#ff6a1a", emit=2.2)
    fire2 = mat("imp_fire2", "#ffe066", emit=3.0)
    R["skin"] = skin
    sphere("imp_body", (0, 0, 0), (0.85, 0.8, 0.85), skin, R)
    for i, (x, tilt, r, d) in enumerate([(-0.28, 0.45, 0.24, 0.7), (0.28, -0.45, 0.24, 0.7), (0.0, 0.0, 0.34, 1.0)]):
        cone(f"imp_flame{i}", (x, 0.05, 0.8 + d * 0.4), (0, tilt, 0), r, d, fire1, R)
        cone(f"imp_flameIn{i}", (x * 0.9, -0.08, 0.76 + d * 0.33), (0, tilt, 0), r * 0.55, d * 0.7, fire2, R)
    sphere("imp_flameBase", (0, 0.02, 0.72), (0.5, 0.4, 0.22), fire1, R)
    for s in (-1, 1):
        cone(f"imp_horn{s}", (s * 0.5, 0, 0.7), (0, s * 0.6, 0), 0.12, 0.35, mat(f"imp_hornm{s}", "#3a0d08"), R)
        w = sphere(f"imp_wing{s}", (s * 0.95, 0.2, 0.2), (0.45, 0.06, 0.32), wing, R)
        w.rotation_euler = (0, s * -0.5, 0)
    lids = []
    eye("imp_eyeL", -0.28, 0.14, 0.19, -0.66, R, lids)
    eye("imp_eyeR", 0.28, 0.14, 0.19, -0.66, R, lids)
    sphere("imp_mouth", (0, -0.74, -0.3), (0.26, 0.06, 0.08), M_MOUTH, R, seg=24)
    for s in (-1, 1):
        cone(f"imp_fang{s}", (s * 0.1, -0.8, -0.36), (math.pi, 0, 0), 0.05, 0.12, M_TOOTH, R)
    MONSTERS["imp"] = dict(root=R, lids=lids, body_r=0.85, ortho=3.1, z_off=0.2)


def build_snowman():
    R = root("snowman")
    snow = mat("snow", "#f4f8ff", rough=0.6, sss=0.3)
    scarf = mat("scarf", "#e8394d", rough=0.6)
    carrot = mat("carrot", "#ff8c1a", rough=0.5)
    R["skin"] = snow
    sphere("sm_bottom", (0, 0, -0.4), (0.95, 0.9, 0.8), snow, R)
    sphere("sm_head", (0, 0, 0.5), (0.68, 0.64, 0.64), snow, R)
    torus("sm_scarf", (0, 0, 0.02), (0, 0, 0), 0.52, 0.12, scarf, R)
    sphere("sm_scarf_tail", (0.3, -0.62, -0.25), (0.12, 0.08, 0.3), scarf, R, seg=24)
    cone("sm_nose", (0, -0.78, 0.46), (math.pi / 2, 0, 0), 0.09, 0.4, carrot, R)
    for s in (-1, 1):
        sphere(f"sm_eye{s}", (s * 0.22, -0.58, 0.66), (0.08, 0.05, 0.09), M_COAL, R, seg=16)
        cone(f"sm_arm{s}", (s * 0.95, 0, -0.1), (0, s * 1.1, 0), 0.04, 0.7, mat(f"twig{s}", "#6b4526"), R, r2=0.02)
    for i in range(3):
        sphere(f"sm_btn{i}", (0, -0.86 + i * 0.02, -0.2 - i * 0.24), (0.07, 0.04, 0.07), M_COAL, R, seg=16)
    for i, a in enumerate((-0.5, -0.25, 0, 0.25, 0.5)):
        sphere(f"sm_mouth{i}", (math.sin(a) * 0.26, -0.6, 0.3 - math.cos(a) * 0.05 + 0.05), (0.035,) * 3, M_COAL, R, seg=12)
    # 모자
    bpy.ops.mesh.primitive_cylinder_add(radius=0.36, depth=0.45, location=(0, 0, 1.28))
    hat = bpy.context.active_object; hat.data.materials.append(M_COAL); hat.parent = R
    bpy.ops.mesh.primitive_cylinder_add(radius=0.55, depth=0.06, location=(0, 0, 1.06))
    brim = bpy.context.active_object; brim.data.materials.append(M_COAL); brim.parent = R
    MONSTERS["snowman"] = dict(root=R, lids=[], body_r=0.95, ortho=3.4, z_off=0.25)


# ── 아이템 ──
def build_heart():
    R = root("heart")
    pink = mat("heart_pink", "#ff4f86", rough=0.45, sss=0.25, emit=0.15, spec=0.3)
    R["skin"] = pink
    for s in (-1, 1):
        sphere(f"heart_lobe{s}", (s * 0.4, 0, 0.25), (0.55, 0.45, 0.55), pink, R)
    cone("heart_tip", (0, 0, -0.35), (math.pi, 0, 0), 0.82, 1.0, pink, R)
    sphere("heart_shine", (-0.45, -0.42, 0.45), (0.14, 0.05, 0.1), M_SHINE, R, seg=16)
    lids = []
    sphere("heart_face", (0, -0.12, 0.0), (0.72, 0.4, 0.6), pink, R)
    eye("heart_eyeL", -0.24, 0.12, 0.15, -0.64, R, lids)
    eye("heart_eyeR", 0.24, 0.12, 0.15, -0.64, R, lids)
    torus("heart_smile", (0, -0.62, -0.16), (math.pi / 2, 0, 0), 0.1, 0.028, M_MOUTH, R)
    MONSTERS["heart"] = dict(root=R, lids=lids, body_r=0.85, ortho=2.6, z_off=0.0)


def build_star():
    R = root("star")
    gold = mat("star_gold", "#ffd23d", rough=0.15, emit=0.6, spec=0.9, coat=1.0)
    R["skin"] = gold
    sphere("star_core", (0, 0, 0), (0.55, 0.4, 0.55), gold, R)
    for i in range(5):
        a = i / 5 * math.tau
        cone(f"star_pt{i}", (math.sin(a) * 0.55, 0, math.cos(a) * 0.55), (0, a, 0), 0.34, 0.75, gold, R)
    lids = []
    eye("star_eyeL", -0.18, 0.08, 0.12, -0.36, R, lids)
    eye("star_eyeR", 0.18, 0.08, 0.12, -0.36, R, lids)
    torus("star_smile", (0, -0.4, -0.14), (math.pi / 2, 0, 0), 0.09, 0.025, M_MOUTH, R)
    MONSTERS["star"] = dict(root=R, lids=lids, body_r=0.85, ortho=2.8, z_off=0.0)


# ── 보스 ──
def build_king_slime():
    R = root("kingslime")
    skin = mat("ks_skin", "#2fd0c0", rough=0.15, sss=0.4, coat=0.7)
    R["skin"] = skin
    sphere("ks_body", (0, 0, -0.05), (1.0, 0.92, 0.82), skin, R)
    for i, (x, z, r) in enumerate([(-0.85, -0.66, 0.26), (0.8, -0.7, 0.22), (0.3, -0.78, 0.18)]):
        sphere(f"ks_drip{i}", (x, -0.1, z), (r, r, r * 0.8), skin, R)
    crown("ks_crown", 0.72, 0.42, R, gem="#ff4d8d")
    lids = []
    eye("ks_eyeL", -0.34, 0.12, 0.2, -0.74, R, lids)
    eye("ks_eyeR", 0.34, 0.12, 0.2, -0.74, R, lids)
    sphere("ks_mouth", (0, -0.82, -0.3), (0.34, 0.1, 0.14), M_MOUTH, R)
    sphere("ks_tongue", (0.06, -0.88, -0.36), (0.14, 0.06, 0.06), M_TONGUE, R, seg=24)
    MONSTERS["kingslime"] = dict(root=R, lids=lids, body_r=1.0, ortho=3.1, z_off=0.15)


def build_ghost_king():
    R = root("ghostking")
    skin = mat("gk_skin", "#b9a4ff", rough=0.25, sss=0.5, emit=0.35, coat=0.4)
    R["skin"] = skin
    sphere("gk_body", (0, 0, 0.1), (0.95, 0.85, 0.95), skin, R)
    for i, (x, z, r) in enumerate([(-0.6, -0.72, 0.34), (0.0, -0.86, 0.38), (0.6, -0.72, 0.34)]):
        sphere(f"gk_tail{i}", (x, 0, z), (r, r * 0.9, r * 1.1), skin, R)
    for s in (-1, 1):
        sphere(f"gk_arm{s}", (s * 1.0, -0.15, 0.1), (0.34, 0.26, 0.24), skin, R).rotation_euler = (0, s * 0.9, 0)
        sphere(f"gk_brow{s}", (s * 0.32, -0.8, 0.56), (0.24, 0.05, 0.06), mat(f"gk_browm{s}", "#3b2470"), R, seg=16).rotation_euler = (0, s * -0.35, 0)
    crown("gk_crown", 0.95, 0.38, R, gem="#7dff8a")
    lids = []
    eye("gk_eyeL", -0.32, 0.36, 0.2, -0.74, R, lids)
    eye("gk_eyeR", 0.32, 0.36, 0.2, -0.74, R, lids)
    sphere("gk_mouth", (0, -0.84, -0.12), (0.42, 0.1, 0.2), M_MOUTH, R)
    for i in range(5):
        cone(f"gk_tooth{i}", (-0.28 + i * 0.14, -0.92, 0.02), (math.pi, 0, 0), 0.055, 0.15, M_TOOTH, R)
    MONSTERS["ghostking"] = dict(root=R, lids=lids, body_r=0.95, ortho=3.3, z_off=0.1)


def build_yeti():
    R = root("yeti")
    fur = mat("yeti_fur", "#eef4ff", rough=0.8, sss=0.2)
    face = mat("yeti_face", "#7fb2ff", rough=0.5)
    hornm = mat("yeti_horn", "#4a5f8a", rough=0.4)
    R["skin"] = face
    sphere("yeti_body", (0, 0, 0), (1.0, 0.9, 0.95), fur, R)
    for i in range(10):     # 털 뭉치
        a = i / 10 * math.tau
        sphere(f"yeti_tuft{i}", (math.cos(a) * 0.92, 0.1, math.sin(a) * 0.86), (0.22, 0.2, 0.22), fur, R, seg=16)
    sphere("yeti_face", (0, -0.62, 0.05), (0.62, 0.35, 0.55), face, R)
    for s in (-1, 1):
        cone(f"yeti_horn{s}", (s * 0.66, 0, 0.9), (0, s * 0.7, 0), 0.18, 0.6, hornm, R)
        sphere(f"yeti_fist{s}", (s * 1.2, -0.25, -0.4), (0.4, 0.4, 0.4), fur, R)
        sphere(f"yeti_brow{s}", (s * 0.27, -0.95, 0.4), (0.2, 0.05, 0.06), hornm, R, seg=16).rotation_euler = (0, s * -0.35, 0)
    lids = []
    eye("yeti_eyeL", -0.26, 0.22, 0.16, -0.92, R, lids)
    eye("yeti_eyeR", 0.26, 0.22, 0.16, -0.92, R, lids)
    sphere("yeti_mouth", (0, -0.96, -0.24), (0.34, 0.08, 0.14), M_MOUTH, R)
    for s in (-1, 1):
        cone(f"yeti_fang{s}", (s * 0.2, -1.0, -0.14), (math.pi, 0, 0), 0.07, 0.2, M_TOOTH, R)
    MONSTERS["yeti"] = dict(root=R, lids=lids, body_r=1.0, ortho=3.5, z_off=0.05)


# ── 중세: 고블린 / 해골 ──
def metal(name, color, rough=0.28):
    m = mat(name, color, rough=rough, spec=0.8)
    set_in(m.node_tree.nodes["Principled BSDF"], ["Metallic"], 0.85)
    return m


M_IRON = metal("iron", "#aab3c2")
M_DARKIRON = metal("darkiron", "#5a6272", rough=0.35)
M_WOOD = mat("wood", "#9a6232", rough=0.7)
M_LEATHER = mat("leather", "#7a4a26", rough=0.6)
M_GOB = mat("gob_skin", "#78c850", rough=0.4, sss=0.15)
M_GOB_DARK = mat("gob_dark", "#4f9a35", rough=0.5)


def cyl(name, loc, rot, r, depth, material, parent, verts=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    o.parent = parent
    return o


def goblin_base(name, R, skin=M_GOB, helmet=True, scale=1.0):
    """큰 머리 + 작은 몸 (치비 비율). 머리 중심 (0,0,0.25) 반지름 ~0.85"""
    R["skin"] = skin
    k = scale
    sphere(f"{name}_head", (0, 0, 0.25 * k), (0.85 * k, 0.78 * k, 0.74 * k), skin, R)
    for s in (-1, 1):   # 뾰족 귀
        cone(f"{name}_ear{s}", (s * 0.95 * k, 0.05, 0.32 * k), (0, s * math.pi / 2 - s * 0.25, 0), 0.2 * k, 0.6 * k, skin, R)
        cone(f"{name}_earIn{s}", (s * 0.93 * k, -0.04, 0.32 * k), (0, s * math.pi / 2 - s * 0.25, 0), 0.11 * k, 0.4 * k, M_TONGUE, R)
    sphere(f"{name}_nose", (0, -0.8 * k, 0.12 * k), (0.14 * k, 0.12 * k, 0.12 * k), M_GOB_DARK, R, seg=24)
    for s_ in (-1, 1):   # 볼터치
        sphere(f"{name}_blush{s_}", (s_ * 0.5 * k, -0.6 * k, 0.05 * k), (0.14 * k, 0.05 * k, 0.08 * k), M_BLUSH, R, seg=24)
    lids = []
    eye(f"{name}_eyeL", -0.3 * k, 0.32 * k, 0.19 * k, -0.62 * k, R, lids)
    eye(f"{name}_eyeR", 0.3 * k, 0.32 * k, 0.19 * k, -0.62 * k, R, lids)
    sphere(f"{name}_mouth", (0, -0.7 * k, -0.18 * k), (0.28 * k, 0.08 * k, 0.1 * k), M_MOUTH, R, seg=24)
    cone(f"{name}_tooth", (0.1 * k, -0.76 * k, -0.12 * k), (math.pi, 0, 0), 0.05 * k, 0.12 * k, M_TOOTH, R)
    # 몸통 + 발
    sphere(f"{name}_body", (0, 0.05, -0.62 * k), (0.52 * k, 0.45 * k, 0.4 * k), skin, R)
    for s in (-1, 1):
        sphere(f"{name}_foot{s}", (s * 0.28 * k, -0.12, -0.98 * k), (0.2 * k, 0.26 * k, 0.12 * k), M_LEATHER, R, seg=24)
        sphere(f"{name}_hand{s}", (s * 0.66 * k, -0.18, -0.55 * k), (0.16 * k,) * 3, skin, R, seg=24)
    if helmet:
        sphere(f"{name}_helm", (0, 0.06, 0.62 * k), (0.88 * k, 0.8 * k, 0.5 * k), M_IRON, R)
        torus(f"{name}_helmRim", (0, 0.03, 0.58 * k), (0, 0, 0), 0.8 * k, 0.06 * k, M_DARKIRON, R)
    return lids


def build_goblin():
    R = root("goblin")
    lids = goblin_base("gob", R)
    # 가슴 갑옷 + 벨트
    sphere("gob_armor", (0, -0.05, -0.58), (0.56, 0.42, 0.36), M_IRON, R)
    torus("gob_belt", (0, 0.05, -0.8), (0, 0, 0), 0.47, 0.05, M_LEATHER, R)
    # 오른손 칼
    cyl("gob_blade", (0.72, -0.3, -0.05), (0.2, 0.25, 0), 0.07, 0.9, M_IRON, R, verts=6)
    cyl("gob_guard", (0.68, -0.26, -0.48), (0, math.pi / 2, 0), 0.05, 0.36, M_WOOD, R, verts=10)
    MONSTERS["goblin"] = dict(root=R, lids=lids, body_r=0.85, ortho=3.4, z_off=0.0)


def build_archer():
    R = root("archer")
    hood = mat("hood", "#4f7a3a", rough=0.75)
    lids = goblin_base("arc", R, helmet=False)
    sphere("arc_hood", (0, 0.12, 0.52), (0.9, 0.8, 0.6), hood, R)
    cone("arc_hoodTip", (0, 0.35, 1.05), (-0.5, 0, 0), 0.25, 0.5, hood, R)
    sphere("arc_cape", (0, 0.15, -0.55), (0.6, 0.45, 0.45), hood, R)
    # 활 (왼손): 반원 토러스 + 줄
    bow = torus("arc_bow", (-0.8, -0.3, -0.25), (0, 0, 0), 0.62, 0.045, M_WOOD, R)
    bow.rotation_euler = (math.pi / 2, 0, 0)
    bow.scale = (0.55, 1.0, 1.0)
    cyl("arc_string", (-0.62, -0.3, -0.25), (0, 0, 0), 0.01, 1.22, M_TOOTH, R, verts=6)
    # 등 뒤 화살통
    cyl("arc_quiver", (0.45, 0.45, -0.15), (0, -0.4, 0), 0.16, 0.8, M_LEATHER, R)
    for i in range(3):
        x = 0.55 + i * 0.07
        cyl(f"arc_shaft{i}", (x, 0.45, 0.35), (0, -0.4, 0), 0.02, 0.5, M_WOOD, R, verts=6)
        cone(f"arc_feather{i}", (x + 0.1, 0.45, 0.6), (0, -0.4, 0), 0.06, 0.16, mat(f"feather{i}", "#ff5a5a"), R)
    MONSTERS["archer"] = dict(root=R, lids=lids, body_r=0.85, ortho=3.4, z_off=0.0)


def build_shield():
    R = root("shield")
    lids = goblin_base("shd", R, skin=mat("shd_skin", "#5fb048", rough=0.4, sss=0.15))
    for s in (-1, 1):   # 투구 뿔
        cone(f"shd_horn{s}", (s * 0.7, 0.05, 0.95), (0, s * 0.7, 0), 0.12, 0.45, M_TOOTH, R)
    # 큰 나무 방패 (정면)
    cyl("shd_board", (0.05, -0.72, -0.58), (math.pi / 2, 0, 0), 0.62, 0.1, M_WOOD, R, verts=48)
    torus("shd_rim", (0.05, -0.78, -0.58), (math.pi / 2, 0, 0), 0.62, 0.05, M_DARKIRON, R)
    sphere("shd_boss", (0.05, -0.82, -0.58), (0.16, 0.08, 0.16), M_IRON, R, seg=24)
    for i in range(4):
        a = i / 4 * math.tau + math.pi / 4
        sphere(f"shd_rivet{i}", (0.05 + math.cos(a) * 0.45, -0.79, -0.58 + math.sin(a) * 0.45), (0.05, 0.03, 0.05), M_IRON, R, seg=12)
    MONSTERS["shield"] = dict(root=R, lids=lids, body_r=0.85, ortho=3.4, z_off=0.0)


def build_skeleton():
    R = root("skeleton")
    bone = mat("bone", "#f2ecdc", rough=0.55)
    socket = mat("socket", "#1a1420", rough=0.6)
    ghostglow = mat("skel_glow", "#6fe8ff", emit=6.0)
    plume = mat("plume", "#e63946", rough=0.7)
    R["skin"] = bone
    sphere("sk_skull", (0, 0, 0.25), (0.8, 0.74, 0.74), bone, R)
    sphere("sk_jaw", (0, -0.22, -0.2), (0.5, 0.45, 0.28), bone, R)
    for s in (-1, 1):
        sphere(f"sk_socket{s}", (s * 0.28, -0.6, 0.26), (0.2, 0.1, 0.22), socket, R)
        sphere(f"sk_pupil{s}", (s * 0.28, -0.68, 0.24), (0.07, 0.04, 0.08), ghostglow, R, seg=16)
        sphere(f"sk_hand{s}", (s * 0.62, -0.18, -0.6), (0.14,) * 3, bone, R, seg=24)
        sphere(f"sk_foot{s}", (s * 0.26, -0.12, -1.0), (0.18, 0.24, 0.1), bone, R, seg=24)
    sphere("sk_nose", (0, -0.72, 0.02), (0.07, 0.04, 0.09), socket, R, seg=16)
    for i in range(5):
        cyl(f"sk_tooth{i}", (-0.2 + i * 0.1, -0.62, -0.18), (0, 0, 0), 0.04, 0.12, bone, R, verts=8)
    # 투구 + 깃털
    sphere("sk_helm", (0, 0.06, 0.62), (0.82, 0.76, 0.48), M_DARKIRON, R)
    torus("sk_helmRim", (0, 0.03, 0.56), (0, 0, 0), 0.76, 0.05, M_IRON, R)
    for i in range(4):
        sphere(f"sk_plume{i}", (0, 0.1 + i * 0.12, 1.1 - i * 0.05), (0.12, 0.2, 0.18), plume, R, seg=16)
    # 갈비뼈 몸
    for i in range(3):
        torus(f"sk_rib{i}", (0, 0.05, -0.45 - i * 0.14), (0, 0, 0), 0.3 - i * 0.04, 0.045, bone, R)
    cyl("sk_spine", (0, 0.2, -0.6), (0, 0, 0), 0.05, 0.6, bone, R, verts=8)
    # 녹슨 칼
    cyl("sk_blade", (0.68, -0.3, -0.1), (0.15, 0.3, 0), 0.07, 0.85, metal("rust", "#9c8a78", rough=0.6), R, verts=6)
    MONSTERS["skeleton"] = dict(root=R, lids=[], body_r=0.8, ortho=3.4, z_off=0.0)


def build_goblin_chief():
    R = root("goblinchief")
    fur = mat("fur", "#8a5a3a", rough=0.9)
    lids = goblin_base("gc", R, skin=mat("gc_skin", "#62b33e", rough=0.4, sss=0.15), scale=1.0)
    for s in (-1, 1):
        cone(f"gc_horn{s}", (s * 0.78, 0.05, 0.9), (0, s * 0.85, 0), 0.16, 0.6, M_TOOTH, R)
        sphere(f"gc_pad{s}", (s * 0.62, 0.05, -0.36), (0.36, 0.34, 0.26), fur, R, seg=24)
        sphere(f"gc_brow{s}", (s * 0.3, -0.72, 0.56), (0.22, 0.05, 0.06), M_GOB_DARK, R, seg=16).rotation_euler = (0, s * -0.4, 0)
        sphere(f"gc_scar{s}", (0.35, -0.74, 0.1 + s * 0.08), (0.03, 0.02, 0.1), mat(f"scar{s}", "#9e3b3b"), R, seg=12)
    crown("gc_crown", 1.08, 0.36, R, gem="#ff3b3b")
    sphere("gc_armor", (0, -0.05, -0.6), (0.6, 0.45, 0.38), M_DARKIRON, R)
    # 큰 도끼
    cyl("gc_handle", (0.85, -0.25, -0.1), (0, 0.2, 0), 0.05, 1.4, M_WOOD, R, verts=10)
    ax = sphere("gc_axe", (0.95, -0.25, 0.5), (0.36, 0.05, 0.3), M_IRON, R)
    ax.rotation_euler = (0, 0.2, 0)
    MONSTERS["goblinchief"] = dict(root=R, lids=lids, body_r=0.85, ortho=3.5, z_off=0.0)


# ── 기사 (아군 꼬마 기사 / 적 흑기사) ──
def build_knight(name, dark=False):
    R = root(name)
    if dark:
        armor = metal(f"{name}_armor", "#3a3548", rough=0.3)
        trim = metal(f"{name}_trim", "#8a2a3a", rough=0.35)
        cloth = mat(f"{name}_cloth", "#4a1f5c", rough=0.6)
        plume_c = "#9b4dff"
        skin = armor
    else:
        armor = metal(f"{name}_armor", "#c9d3e3", rough=0.22)
        trim = metal(f"{name}_trim", "#ffc53d", rough=0.2)
        cloth = mat(f"{name}_cloth", "#2f6fe0", rough=0.55)
        plume_c = "#ff3b5c"
        skin = mat(f"{name}_skin", "#ffd7b5", rough=0.5, sss=0.25)
    R["skin"] = skin
    lids = []
    if dark:
        # 투구 얼굴가리개 + 빛나는 눈
        sphere(f"{name}_head", (0, 0, 0.25), (0.8, 0.74, 0.74), armor, R)
        sphere(f"{name}_visor", (0, -0.6, 0.22), (0.62, 0.22, 0.42), mat(f"{name}_visorm", "#15121c", rough=0.3), R)
        red = mat(f"{name}_eyes", "#ff3048", emit=7.0)
        for s_ in (-1, 1):
            sphere(f"{name}_eye{s_}", (s_ * 0.24, -0.8, 0.26), (0.13, 0.04, 0.05), red, R, seg=16).rotation_euler = (0, s_ * 0.3, 0)
    else:
        sphere(f"{name}_head", (0, 0, 0.22), (0.78, 0.72, 0.7), skin, R)
        eye(f"{name}_eyeL", -0.27, 0.24, 0.17, -0.6, R, lids)
        eye(f"{name}_eyeR", 0.27, 0.24, 0.17, -0.6, R, lids)
        for s_ in (-1, 1):
            sphere(f"{name}_blush{s_}", (s_ * 0.44, -0.58, 0.02), (0.12, 0.05, 0.07), M_BLUSH, R, seg=24)
        sphere(f"{name}_mouth", (0, -0.64, -0.13), (0.15, 0.06, 0.07), M_MOUTH, R, seg=24)
        sphere(f"{name}_tongue", (0.02, -0.68, -0.16), (0.07, 0.04, 0.03), M_TONGUE, R, seg=16)
    # 투구
    sphere(f"{name}_helm", (0, 0.05, 0.58), (0.86, 0.8, 0.5), armor, R)
    torus(f"{name}_helmRim", (0, 0.03, 0.52), (0, 0, 0), 0.79, 0.06, trim, R)
    for s_ in (-1, 1):
        sphere(f"{name}_cheek{s_}", (s_ * 0.74, -0.05, 0.2), (0.14, 0.3, 0.34), armor, R)
    for i in range(4):
        sphere(f"{name}_plume{i}", (0, 0.05 + i * 0.13, 1.06 - i * 0.07), (0.13, 0.2, 0.17), mat(f"{name}_pl{i}", plume_c, rough=0.7), R, seg=16)
    # 몸통
    sphere(f"{name}_body", (0, 0.05, -0.62), (0.54, 0.46, 0.42), cloth, R)
    sphere(f"{name}_chest", (0, -0.1, -0.52), (0.46, 0.34, 0.3), armor, R)
    torus(f"{name}_belt", (0, 0.05, -0.78), (0, 0, 0), 0.47, 0.05, trim, R)
    for s_ in (-1, 1):
        sphere(f"{name}_pad{s_}", (s_ * 0.56, 0.02, -0.34), (0.24, 0.24, 0.16), armor, R, seg=24)
        sphere(f"{name}_hand{s_}", (s_ * 0.66, -0.2, -0.55), (0.15,) * 3, armor, R, seg=24)
        sphere(f"{name}_foot{s_}", (s_ * 0.27, -0.12, -0.98), (0.2, 0.27, 0.12), mat(f"{name}_boot{s_}", "#3b2a22", rough=0.6), R, seg=24)
    # 검 (오른손, 위로 치켜듦)
    blade = metal(f"{name}_blade", "#eef3ff", rough=0.12)
    cyl(f"{name}_blade", (0.74, -0.32, 0.18), (0, 0.18, 0), 0.06, 1.1, blade, R, verts=6)
    cyl(f"{name}_guard", (0.67, -0.32, -0.36), (0, math.pi / 2 + 0.18, 0), 0.05, 0.4, trim, R, verts=10)
    sphere(f"{name}_pommel", (0.64, -0.32, -0.52), (0.07,) * 3, trim, R, seg=16)
    # 둥근 방패 (왼손)
    board = mat(f"{name}_shield", "#2a2240" if dark else "#2f6fe0", rough=0.45)
    cyl(f"{name}_sboard", (-0.72, -0.48, -0.45), (math.pi / 2, 0, 0), 0.42, 0.08, board, R, verts=40)
    torus(f"{name}_srim", (-0.72, -0.53, -0.45), (math.pi / 2, 0, 0), 0.42, 0.045, trim, R)
    emb = mat(f"{name}_emb", "#ff3048" if dark else "#ffc53d", rough=0.2, emit=1.5 if dark else 0.0)
    for rot in (0, math.pi / 2):   # 십자 문장
        bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.72, -0.56, -0.45), rotation=(0, rot, 0))
        c = bpy.context.active_object; c.name = f"{name}_emblem"; c.scale = (0.08, 0.03, 0.5)
        c.data.materials.append(emb); c.parent = R
    MONSTERS[name] = dict(root=R, lids=lids, body_r=0.82, ortho=3.5, z_off=0.05)


# ── 드래곤 (최종 보스) ──
def build_dragon():
    R = root("dragon")
    skin = mat("dr_skin", "#2fbf86", rough=0.3, sss=0.15, coat=0.4)
    belly = mat("dr_belly", "#ffe08a", rough=0.45)
    wing = mat("dr_wing", "#1d7a63", rough=0.5, sss=0.2)
    membrane = mat("dr_membrane", "#8a5cff", rough=0.5, sss=0.3)
    hornm = mat("dr_horn", "#fff3d6", rough=0.3, coat=0.5)
    fire = mat("dr_fire", "#ff7a1a", emit=4.0)
    R["skin"] = skin
    sphere("dr_body", (0, 0.1, -0.55), (0.72, 0.62, 0.55), skin, R)
    sphere("dr_belly", (0, -0.38, -0.58), (0.5, 0.3, 0.44), belly, R)
    for i in range(3):
        torus(f"dr_plate{i}", (0, -0.58, -0.4 - i * 0.16), (math.pi / 2, 0, 0), 0.26 - i * 0.03, 0.025, mat(f"dr_pl{i}", "#e8b84a"), R)
    sphere("dr_head", (0, 0, 0.32), (0.86, 0.8, 0.72), skin, R)
    sphere("dr_snout", (0, -0.72, 0.1), (0.46, 0.34, 0.3), skin, R)
    for s_ in (-1, 1):
        sphere(f"dr_nostril{s_}", (s_ * 0.16, -1.02, 0.2), (0.06, 0.03, 0.05), fire, R, seg=12)
        cone(f"dr_horn{s_}", (s_ * 0.5, 0.25, 0.95), (-0.5, s_ * 0.45, 0), 0.14, 0.6, hornm, R)
        cone(f"dr_fin{s_}", (s_ * 0.82, 0.1, 0.45), (0, s_ * 1.2, 0), 0.16, 0.42, membrane, R)
        sphere(f"dr_brow{s_}", (s_ * 0.3, -0.66, 0.66), (0.22, 0.06, 0.07), mat(f"dr_bm{s_}", "#156148"), R, seg=16).rotation_euler = (0, s_ * -0.35, 0)
        # 큰 날개
        w = sphere(f"dr_wing{s_}", (s_ * 1.25, 0.3, 0.2), (0.85, 0.06, 0.62), membrane, R)
        w.rotation_euler = (0, s_ * -0.45, 0)
        bone = sphere(f"dr_wbone{s_}", (s_ * 1.2, 0.26, 0.55), (0.9, 0.08, 0.1), wing, R)
        bone.rotation_euler = (0, s_ * -0.55, 0)
        cone(f"dr_claw{s_}", (s_ * 1.95, 0.25, 0.95), (0, s_ * -1.0, 0), 0.07, 0.22, hornm, R)
        sphere(f"dr_hand{s_}", (s_ * 0.55, -0.35, -0.5), (0.16, 0.16, 0.16), skin, R, seg=24)
        sphere(f"dr_foot{s_}", (s_ * 0.34, -0.2, -1.02), (0.24, 0.3, 0.13), skin, R, seg=24)
    lids = []
    eye("dr_eyeL", -0.32, 0.46, 0.19, -0.66, R, lids)
    eye("dr_eyeR", 0.32, 0.46, 0.19, -0.66, R, lids)
    # 벌린 입 + 불꽃
    sphere("dr_mouth", (0, -0.94, -0.05), (0.3, 0.1, 0.12), M_MOUTH, R)
    sphere("dr_mouthfire", (0, -0.98, -0.05), (0.16, 0.05, 0.06), fire, R, seg=16)
    for s_ in (-1, 1):
        cone(f"dr_fang{s_}", (s_ * 0.17, -1.0, 0.04), (math.pi, 0, 0), 0.05, 0.14, M_TOOTH, R)
    # 등 가시 + 꼬리
    for i in range(4):
        cone(f"dr_spike{i}", (0, 0.45 + i * 0.12, 0.95 - i * 0.28), (-0.7, 0, 0), 0.1, 0.28, hornm, R)
    for i in range(5):
        t = i / 4
        sphere(f"dr_tail{i}", (0.55 + t * 0.75, 0.3, -0.85 + math.sin(t * 2.4) * 0.35), (0.2 - t * 0.09,) * 3, skin, R, seg=24)
    cone("dr_tailtip", (1.4, 0.3, -0.42), (0, 0.6, 0), 0.12, 0.3, membrane, R)
    MONSTERS["dragon"] = dict(root=R, lids=lids, body_r=0.9, ortho=4.3, z_off=0.05)


ONLY = set(argv[2].split(",")) if len(argv) > 2 else None   # 일부만 다시 렌더: -- out EEVEE ghost,bee

for fn in (build_slime, build_bat, build_horn, build_boss, build_ghost, build_mushroom, build_bee, build_golem,
           build_bomb, build_imp, build_snowman, build_heart, build_star, build_king_slime, build_ghost_king, build_yeti,
           build_goblin, build_archer, build_shield, build_skeleton, build_goblin_chief, build_dragon,
           lambda: build_knight("knight"), lambda: build_knight("darkknight", dark=True)):
    fn()

# ─────────────── 조명 / 카메라 ───────────────
def light(name, kind, energy, loc, rot, size=None, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    ld.color = color
    if size is not None:
        ld.size = size
    o = bpy.data.objects.new(name, ld)
    o.location = loc
    o.rotation_euler = rot
    scene.collection.objects.link(o)


light("key", "AREA", 900, (-3.5, -5, 4.5), (math.radians(55), 0, math.radians(-35)), size=4)
light("fill", "AREA", 260, (4, -4, 0.5), (math.radians(80), 0, math.radians(45)), size=5, color=(0.8, 0.9, 1))
light("rim", "AREA", 1100, (0, 5, 3), (math.radians(-60), 0, math.radians(180)), size=3, color=(0.75, 0.95, 1))

cam_data = bpy.data.cameras.new("cam")
cam_data.type = "ORTHO"
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
TILT = math.radians(8)   # 살짝 내려다봄
cam.rotation_euler = (math.pi / 2 - TILT, 0, 0)

# ─────────────── 만화풍 외곽선 (inverted hull) ───────────────
M_OUTLINE = mat("outline", "#1b1330", rough=1.0, spec=0.0)
M_OUTLINE.use_backface_culling = True
for attr in ("use_backface_culling_shadow", "use_backface_culling_lightprobe_volume"):
    if hasattr(M_OUTLINE, attr):
        setattr(M_OUTLINE, attr, True)
# 외곽선 껍데기가 몸에 그림자를 드리우지 않게
try:
    M_OUTLINE.shadow_method = 'NONE'
except (AttributeError, TypeError):
    pass
NO_OUTLINE = ("shine", "pupil", "lidline", "mouth", "tongue", "tooth", "gem", "xeye", "spark", "ray", "string",
              "fang", "glow", "blush", "flameIn", "scar", "rivet", "btn", "_eye1", "_eye-1")


def add_outlines():
    for o in list(scene.objects):
        if o.type != 'MESH':
            continue
        # 비균일 스케일을 메시에 굽기 → 외곽선 두께가 고르게
        sc = o.scale.copy()
        if any(abs(v - 1) > 1e-6 for v in sc):
            o.data.transform(Matrix.Diagonal((sc.x, sc.y, sc.z, 1.0)))
            o.scale = (1, 1, 1)
        if any(k in o.name for k in NO_OUTLINE):
            continue
        size = max(o.dimensions)
        if size < 0.14:
            continue
        o.data.materials.append(M_OUTLINE)
        m = o.modifiers.new("outline", 'SOLIDIFY')
        m.thickness = 0.035 if size > 0.4 else 0.022
        m.offset = 1.0
        m.use_flip_normals = True
        m.use_rim = False
        m.material_offset = len(o.data.materials) - 1


add_outlines()

# ─────────────── 렌더 ───────────────
FRAMES = {
    "0": dict(sx=1.0, sz=1.0),                    # 기본
    "1": dict(sx=1.06, sz=0.93),                  # 찌그러짐(통통 튀는 느낌)
    "2": dict(sx=1.0, sz=1.0, blink=True),        # 눈 깜빡임
    "3": dict(sx=0.95, sz=1.06, hurt=True, tilt=0.12),   # 맞음: X 눈 + 움찔
    "4": dict(sx=1.0, sz=0.98, step=1, tilt=0.07),       # 달리기 A (왼발 들기)
    "5": dict(sx=1.0, sz=0.98, step=-1, tilt=-0.07),     # 달리기 B (오른발 들기)
}


def limbs(root_obj):
    """발/손 오브젝트와 원래 위치 (s=-1 왼쪽, 1 오른쪽)"""
    out = []
    for o in root_obj.children_recursive:
        for part in ("_foot", "_hand", "_fist", "_arm"):
            if part in o.name:
                side = -1 if o.name.endswith("-1") else 1
                out.append((o, part, side, o.location.copy()))
    return out

manifest = {"frames": list(FRAMES.keys()), "monsters": {}}
names = list(MONSTERS.keys())

for name in names:
    info = MONSTERS[name]
    # 다른 몬스터 숨김
    for other in names:
        hide = other != name
        for o in [MONSTERS[other]["root"]] + list(MONSTERS[other]["root"].children_recursive):
            o.hide_render = hide
    # 게임 쪽: 스프라이트 한 변 = 히트박스 반지름 × (ortho / body_r)
    manifest["monsters"][name] = {
        "sizePerRadius": round(info["ortho"] / info["body_r"], 4),
        # 본체 중심이 이미지 중앙에서 얼마나 아래(+)/위(-)에 있는지 (이미지 높이 비율)
        "centerOffsetY": round(info["z_off"] / info["ortho"], 4),
    }
    if ONLY and name not in ONLY:
        continue
    dist = 10
    cam.location = (0, -dist * math.cos(TILT), dist * math.sin(TILT) + info["z_off"])
    cam_data.ortho_scale = info["ortho"]

    ex = EXTRA.get(name, {"hurt_hide": [], "hurt_show": []})
    lb = limbs(info["root"])
    for fid, f in FRAMES.items():
        info["root"].scale = (f["sx"], f["sx"], f["sz"])
        info["root"].rotation_euler = (0, f.get("tilt", 0), 0)
        for lid in info["lids"]:
            lid.hide_render = not f.get("blink", False)
        hurt = f.get("hurt", False)
        for o in ex["hurt_hide"]:
            o.hide_render = hurt
        for o in ex["hurt_show"]:
            o.hide_render = not hurt
        step = f.get("step", 0)
        for o, part, side, loc in lb:
            o.location = loc.copy()
            if step:
                up = (side == -step)          # 들어 올리는 쪽
                if part == "_foot":
                    o.location.z += 0.13 if up else -0.02
                    o.location.y += -0.08 if up else 0.04
                else:                          # 팔은 발과 반대로 흔듦
                    o.location.z += -0.06 if up else 0.08
                    o.location.y += 0.06 if up else -0.08
        scene.render.filepath = os.path.join(OUT, f"{name}_{fid}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[ok] {name}_{fid}.png")
    info["root"].scale = (1, 1, 1)
    info["root"].rotation_euler = (0, 0, 0)
    for o, part, side, loc in lb:
        o.location = loc

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fp:
    json.dump(manifest, fp, indent=2)
print("[done]", OUT)
