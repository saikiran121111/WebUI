/**
 * Auto-framing: fits the camera to whatever was built, so a model never has
 * to guess a good viewpoint. Distance = bounding radius / sin(fov/2) with a
 * 35% margin, from a fixed three-quarter direction.
 */
export interface FramedView {
  center: any;
  distance: number;
  position: any;
}

export function frameObject(three: any, object: any, fovDeg: number): FramedView {
  const box = new three.Box3().setFromObject(object);
  const sphere = box.isEmpty()
    ? new three.Sphere(new three.Vector3(0, 0, 0), 5)
    : box.getBoundingSphere(new three.Sphere());

  const radius = Math.max(sphere.radius, 0.5);
  const fovRad = (fovDeg * Math.PI) / 180;
  const distance = Math.max((radius / Math.sin(fovRad / 2)) * 1.35, 1.5);
  const dir = new three.Vector3(0.55, 0.4, 0.75).normalize();

  return {
    center: sphere.center.clone(),
    distance,
    position: sphere.center.clone().add(dir.multiplyScalar(distance)),
  };
}
