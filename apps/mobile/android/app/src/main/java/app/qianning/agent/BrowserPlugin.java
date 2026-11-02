package app.qianning.agent;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens the in-app browser window. One method, because the window owns
 * everything else: navigation, progress and closing.
 */
@CapacitorPlugin(name = "QnBrowser")
public class BrowserPlugin extends Plugin {

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || url.trim().isEmpty()) {
            call.reject("missing url");
            return;
        }
        Intent intent = new Intent(getContext(), BrowserActivity.class);
        intent.putExtra("url", url);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);

        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /**
     * What the open window is showing. The text is the rendered page, so a
     * script-built list is readable where `fetch_url` would return an empty
     * shell of a document.
     */
    @PluginMethod
    public void read(PluginCall call) {
        String[] snapshot = BrowserActivity.snapshot();
        JSObject result = new JSObject();
        result.put("open", BrowserActivity.isOpen());
        result.put("url", snapshot[0]);
        result.put("title", snapshot[1]);
        result.put("text", snapshot[2]);
        call.resolve(result);
    }

    @PluginMethod
    public void close(PluginCall call) {
        BrowserActivity.closeWindow();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }
}
