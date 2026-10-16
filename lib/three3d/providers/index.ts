/**
 * Provider selection, server-side. With no credentials configured the app
 * stays honest: asset3d requests report "provider not configured" and the
 * procedural scene3d path keeps working — no fake AI fallback.
 */
import { isMeshyConfigured } from "./meshy";

export type ProviderId = "meshy";

export function getActiveProvider(): ProviderId | null {
  if (isMeshyConfigured()) return "meshy";
  return null; // TRELLIS / local generators plug in here when configured.
}
