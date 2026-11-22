import { describe, expect, it } from "vitest";
import { backCameras, pickMainBackCamera } from "./camera";

const dev = (deviceId: string, label: string, kind: MediaDeviceKind = "videoinput") => ({ deviceId, label, kind });

describe("cámara del escáner", () => {
  it("Android: elige «camera2 0» aunque la gran angular salga antes", () => {
    const backs = backCameras([
      dev("a", "camera2 2, facing back"),
      dev("b", "camera2 1, facing front"),
      dev("c", "camera2 0, facing back"),
      dev("m", "Micrófono", "audioinput"),
    ]);
    expect(backs.map((c) => c.deviceId)).toEqual(["a", "c"]);
    expect(pickMainBackCamera(backs)?.deviceId).toBe("c");
  });

  it("iOS: descarta ultra gran angular, tele y la dual", () => {
    const backs = backCameras([
      dev("u", "Cámara ultra gran angular trasera"),
      dev("d", "Cámara dual gran angular trasera"),
      dev("t", "Cámara con teleobjetivo trasera"),
      dev("p", "Cámara trasera"),
      dev("f", "Cámara frontal"),
    ]);
    expect(pickMainBackCamera(backs)?.deviceId).toBe("p");
  });

  it("si todas parecen secundarias, se queda con alguna; sin traseras, null", () => {
    expect(pickMainBackCamera(backCameras([dev("u", "Back Ultra Wide Camera")]))?.deviceId).toBe("u");
    expect(pickMainBackCamera(backCameras([dev("f", "camera2 1, facing front"), dev("x", "")]))).toBeNull();
  });
});
