package app.qianning.agent;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The JavaScript door to the alarm manager.
 *
 * The client owns the schedule list; this side owns the platform timers. A sync
 * is always "cancel everything, then place what the client currently believes",
 * which keeps the two from drifting after an edit, a delete or a clock change.
 */
@CapacitorPlugin(name = "ScheduleAlarms")
public class ScheduleAlarmPlugin extends Plugin {

    @PluginMethod
    public void schedule(PluginCall call) {
        String id = call.getString("id");
        Long at = call.getLong("at");
        String title = call.getString("title", "");
        if (id == null || at == null) {
            call.reject("id and at are required");
            return;
        }

        Context context = getContext();
        Alarms.schedule(context, id, at, title);

        JSObject result = new JSObject();
        AlarmManagerInfo info = new AlarmManagerInfo(context);
        result.put("exact", info.exact);
        call.resolve(result);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        Alarms.cancel(getContext(), id);
        call.resolve();
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        Alarms.cancelAll(getContext());
        call.resolve();
    }

    /** Lets the settings page say whether these alarms will be exact. */
    @PluginMethod
    public void info(PluginCall call) {
        AlarmManagerInfo info = new AlarmManagerInfo(getContext());
        JSObject result = new JSObject();
        result.put("exact", info.exact);
        result.put("pending", AlarmStore.all(getContext()).size());
        call.resolve(result);
    }

    private static final class AlarmManagerInfo {
        final boolean exact;

        AlarmManagerInfo(Context context) {
            android.app.AlarmManager manager =
                    (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            exact = manager != null
                    && (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S
                    || manager.canScheduleExactAlarms());
        }
    }
}
