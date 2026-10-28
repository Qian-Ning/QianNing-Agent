package app.qianning.agent;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Android drops every alarm on reboot; the mirror in {@link AlarmStore} is what
 * lets them come back without the user opening the app.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            Alarms.restore(context);
        }
    }
}
