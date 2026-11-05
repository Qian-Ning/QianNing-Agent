package app.qianning.agent;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * The web layer decides what "back" means here: close a sheet, leave
     * settings, close the drawer, leave a conversation. Only when it answers
     * "not handled" does the activity go to the background — finishing it on
     * the first back press from the sessions list closed the whole app.
     */
    @Override
    public void onBackPressed() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            moveTaskToBack(true);
            return;
        }
        getBridge()
                .getWebView()
                .evaluateJavascript(
                        "(function(){try{return window.__qianningBack?String(window.__qianningBack()===true):'false';}catch(e){return 'false';}})()",
                        value -> {
                            boolean handled = "\"true\"".equals(value) || "true".equals(value);
                            if (!handled) {
                                runOnUiThread(() -> moveTaskToBack(true));
                            }
                        });
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts so the WebView can call it on
        // its first render.
        registerPlugin(AgentKeepAlivePlugin.class);
        registerPlugin(ScheduleAlarmPlugin.class);
        registerPlugin(NoticePlugin.class);
        registerPlugin(ShellPlugin.class);
        registerPlugin(BrowserPlugin.class);
        registerPlugin(FilesPlugin.class);
        registerPlugin(RemoteHostPlugin.class);
        registerPlugin(SshPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
