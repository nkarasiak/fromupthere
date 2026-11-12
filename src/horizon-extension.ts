import { LayerExtension, type Layer } from '@deck.gl/core';

// MapLibre's globe doesn't write true depth (its shader sets depth from a horizon clipping plane), so near the limb
// deck's ground features from the far side of the Earth passed the depth test and showed through it (a 24 h swath
// window lit up the pole). Drop what lies beyond the horizon: P . C < R^2 in deck's globe space (R = 256).
const horizonModule = {
  name: 'horizon',
  fs: /* glsl */ 'layout(std140) uniform horizonUniforms { vec3 camera; } horizon;',
  uniformTypes: { camera: 'vec3<f32>' }
} as const;

export class HorizonExtension extends LayerExtension {
  static extensionName = 'HorizonExtension';

  getShaders() {
    return {
      modules: [horizonModule],
      inject: {
        'vs:#decl': 'out vec3 horizon_position;',
        'vs:DECKGL_FILTER_GL_POSITION': 'horizon_position = geometry.position.xyz;',
        'fs:#decl': 'in vec3 horizon_position;',
        'fs:DECKGL_FILTER_COLOR': 'if (dot(horizon_position, horizon.camera) < 65536.0) discard;'
      }
    };
  }

  draw(this: Layer) { // run with the layer as `this`
    this.setShaderModuleProps({ horizon: { camera: this.context.viewport.cameraPosition } });
  }
}
