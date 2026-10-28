package app.qianning.agent;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * The web layer decides what "back" means here: close a sheet, leave
     * settings, close the drawer, leave a conversation. Only when it answers
     * "not handled" does the system get to finish the activity, so a back
     * gesture inside the app no longer closes it.
     */
    @Override
    public void onBackPressed() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            super.onBackPressed();
            return;
        }
        getBridge()
                .getWebView()
                .evaluateJavascript(
                        "(function(){try{return window.__qianningBack?String(window.__qianningBack()===true):'false';}catch(e){return 'false';}})()",
                        value -> {
                            boolean handled = "\"true\"".equals(value) || "true".equals(value);
                            if (!handled) {
                                runOnUiThread(MainActivity.this::systemBack);
                            }
                        });
    }

    private void systemBack() {
        super.onBackPressed();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts so the WebView can call it on
        // its first render.
        registerPlugin(AgentKeepAlivePlugin.class);
        registerPlugin(ScheduleAlarmPlugin.class);
        registerPlugin(NoticePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
