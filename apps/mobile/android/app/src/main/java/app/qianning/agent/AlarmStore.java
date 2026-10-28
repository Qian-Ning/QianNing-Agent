package app.qianning.agent;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * The alarms the system holds on the app's behalf, mirrored in preferences.
 *
 * Android forgets every alarm when the phone reboots, and the schedules
 * themselves live in the WebView's storage where a boot receiver cannot reach
 * them. Keeping a copy here is what lets {@link BootReceiver} put them back
 * without waking the UI.
 */
final class AlarmStore {

    private static final String PREFS = "qn.alarms";

    private AlarmStore() {}

    static final class Entry {
        final String id;
        final long at;
        final String title;

        Entry(String id, long at, String title) {
            this.id = id;
            this.at = at;
            this.title = title;
        }
    }

    static void put(Context context, String id, long at, String title) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject entry = new JSONObject();
        try {
            entry.put("at", at);
            entry.put("title", title);
        } catch (JSONException ignored) {
            return;
        }
        preferences.edit().putString(id, entry.toString()).apply();
    }

    static void remove(Context context, String id) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(id).apply();
    }

    static void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    static List<Entry> all(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        List<Entry> entries = new ArrayList<>();
        for (Iterator<String> keys = preferences.getAll().keySet().iterator(); keys.hasNext(); ) {
            String id = keys.next();
            String raw = preferences.getString(id, null);
            if (raw == null) continue;
            try {
                JSONObject parsed = new JSONObject(raw);
                entries.add(new Entry(id, parsed.getLong("at"), parsed.optString("title", "")));
            } catch (JSONException ignored) {
                // A damaged entry is dropped on the next sync.
            }
        }
        return entries;
    }
}
