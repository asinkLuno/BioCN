import bpy
import math
from mathutils import Vector, Matrix, Quaternion

# Three-dimensional S/V/O letterforms arranged on two intertwined DNA paths.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 80
scene.render.resolution_x = 1400
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.film_transparent = True
scene.view_settings.view_transform = 'AgX'

mat = bpy.data.materials.new('Graphite jade')
mat.diffuse_color = (0.055, 0.16, 0.13, 1)
mat.use_nodes = True
shader = mat.node_tree.nodes.get('Principled BSDF')
shader.inputs['Base Color'].default_value = (0.055, 0.16, 0.13, 1)
shader.inputs['Metallic'].default_value = 0.12
shader.inputs['Roughness'].default_value = 0.28

turns = 1.45
height = 7.4
radius = 1.05
count = 23
font_size = 0.50
view_normal = Vector((7, -16, 4)).normalized()


def helix_position(t, phase):
    angle = math.tau * turns * t + phase
    return Vector((radius * math.cos(angle), radius * math.sin(angle), height * (t - 0.5)))


def add_letter(char, t, phase, strand, index):
    angle = math.tau * turns * t + phase
    pos = helix_position(t, phase)
    tangent = Vector((-math.sin(angle) * math.tau * turns * radius,
                      0,
                      height)).normalized()
    tangent = (tangent - view_normal * tangent.dot(view_normal)).normalized()
    up = view_normal.cross(tangent).normalized()
    basis = Matrix((tangent, up, view_normal)).transposed().to_4x4()

    curve = bpy.data.curves.new(f'{char} face', 'FONT')
    curve.body = char
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    curve.size = font_size
    curve.extrude = 0.07
    curve.bevel_depth = 0.012
    curve.bevel_resolution = 3
    curve.resolution_u = 24
    obj = bpy.data.objects.new(f'Chain {strand} · {char}{index:02d}', curve)
    bpy.context.collection.objects.link(obj)
    obj.location = pos + view_normal * 0.06
    obj.rotation_euler = basis.to_euler()
    curve.materials.append(mat)


for strand, phase in enumerate((0, math.pi), start=1):
    for i in range(count):
        t = 0.025 + 0.95 * i / (count - 1)
        add_letter(('S', 'V', 'O')[(i + strand - 1) % 3], t, phase, strand, i + 1)

# Camera looks across the helix, exposing its 3D depth. Roll gives the requested diagonal.
def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.object.camera_add(location=view_normal * 20)
camera = bpy.context.object
camera.name = 'Three-quarter logo camera'
q = (-camera.location).to_track_quat('-Z', 'Y')
camera.rotation_mode = 'QUATERNION'
camera.rotation_quaternion = q @ Quaternion((0, 0, 1), math.radians(45))
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 9.6
scene.camera = camera

for name, loc, energy, size in (
    ('Key softbox', (1, -8, 9), 1800, 7),
    ('Fill', (-7, -4, 2), 1200, 6),
    ('Rim', (4, 5, 6), 1800, 5),
):
    bpy.ops.object.light_add(type='AREA', location=loc)
    light = bpy.context.object
    light.name = name
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
    point_at(light, (0, 0, 0))

scene.world.color = (0.045, 0.055, 0.05)
scene.render.filepath = '/home/guozr/CODE/BioCN/design/logo/svo-helix-logo.png'
bpy.ops.wm.save_as_mainfile(filepath='/home/guozr/CODE/BioCN/design/logo/svo-helix-logo.blend')
bpy.ops.render.render(write_still=True)
