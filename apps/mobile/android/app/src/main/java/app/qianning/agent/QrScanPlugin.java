package app.qianning.agent;

import android.Manifest;
import android.app.Activity;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * One QR code, read by the camera.
 *
 * The desktop draws the pairing link as a code, so the phone should be able to
 * take it without a person typing an address and a token off a monitor. The
 * decoding is left to zxing's own activity, which already handles rotation,
 * focus and the permission prompt; this class only owns the plugin call.
 *
 * If the camera is denied or the user backs out, the rejection carries a code
 * the page can phrase — `camera-denied` and `cancelled` are different answers.
 */
@CapacitorPlugin(
        name = "QrScan",
        permissions = @Permission(alias = "camera", strings = {Manifest.permission.CAMERA}))
public class QrScanPlugin extends Plugin {

    private PluginCall pending;

    @PluginMethod
    public void scan(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraResult");
            return;
        }
        open(call);
    }

    @PermissionCallback
    private void cameraResult(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            open(call);
            return;
        }
        call.reject("camera-denied");
    }

    private void open(PluginCall call) {
        Activity activity = getActivity();
        if (!(activity instanceof MainActivity)) {
            call.reject("no-activity");
            return;
        }
        // Only one code can be scanned at a time; a second request supersedes
        // nothing and would leave the first call unresolved.
        if (pending != null) {
            call.reject("busy");
            return;
        }
        pending = call;
        ((MainActivity) activity).beginQrScan(this);
    }

    /** Called by the activity with the decoded text, or null when the scan was abandoned. */
    void deliver(String text) {
        PluginCall call = pending;
        pending = null;
        if (call == null) {
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            call.reject("cancelled");
            return;
        }
        JSObject result = new JSObject();
        result.put("text", text.trim());
        call.resolve(result);
    }
}
