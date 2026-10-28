package app.qianning.agent;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before the bridge starts so the WebView can call it on
        // its first render.
        registerPlugin(AgentKeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
