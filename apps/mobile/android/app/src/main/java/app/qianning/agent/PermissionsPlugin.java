package app.qianning.agent;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The three permissions the phone actually needs, reported and requested in one
 * place, so the first-run screen does not have to know which Android version
 * gates which dialog.
 *
 * Notifications are a runtime permission from 13. Exact alarms became a special
 * access in 12, and battery optimisation has been one since 6 — the last two
 * cannot be granted in a dialog, only in a settings page the reader confirms.
 * Every method therefore reports the state again rather than assuming the tap
 * granted anything.
 */
@CapacitorPlugin(
        name = "AgentPermissions",
        permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") })
public class PermissionsPlugin extends Plugin {

    @PluginMethod
    public void state(PluginCall call) {
        call.resolve(describe());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || notificationsGranted(getContext())) {
            JSObject result = describe();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.DENIED
                && !getActivity().shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            // Android will not draw the dialog a second time; the settings page is
            // the only path left, and the caller already offers it.
            JSObject result = describe();
            result.put("granted", false);
            call.resolve(result);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsResult");
    }

    @PermissionCallback
    private void notificationsResult(PluginCall call) {
        JSObject result = describe();
        result.put("granted", notificationsGranted(getContext()));
        call.resolve(result);
    }

    /**
     * Opens the system page that asks about battery optimisation. The answer is
     * not delivered to us — Android only reports it through the same query we
     * already make — so the caller re-reads `state` when the app comes back.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        Context context = getContext();
        if (ignoringBatteryOptimisations(context)) {
            JSObject result = describe();
            result.put("launched", false);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        call.resolve(launch(intent));
    }

    @PluginMethod
    public void requestExactAlarms(PluginCall call) {
        Context context = getContext();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || exactAlarmsAllowed(context)) {
            JSObject result = describe();
            result.put("launched", false);
            call.resolve(result);
            return;
        }
        Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        call.resolve(launch(intent));
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Context context = getContext();
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
        }
        call.resolve(launch(intent));
    }

    private JSObject launch(Intent intent) {
        JSObject result = describe();
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            result.put("launched", true);
        } catch (Exception error) {
            result.put("launched", false);
            result.put("error", error.getMessage() == null ? "no settings page" : error.getMessage());
        }
        return result;
    }

    private JSObject describe() {
        Context context = getContext();
        JSObject result = new JSObject();
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("notifications", notificationsGranted(context));
        result.put("notificationsRuntime", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU);
        result.put("batteryOptimised", !ignoringBatteryOptimisations(context));
        result.put("exactAlarms", exactAlarmsAllowed(context));
        return result;
    }

    private static boolean notificationsGranted(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true;
        }
        return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean ignoringBatteryOptimisations(Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    private static boolean exactAlarmsAllowed(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        return ((android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE))
                .canScheduleExactAlarms();
    }
}
