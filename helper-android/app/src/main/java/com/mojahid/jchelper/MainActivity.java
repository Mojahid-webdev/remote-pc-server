package com.mojahid.jchelper;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private EditText eServer, eToken, eName, eMac;
    private TextView tStatus, tBattery;
    private final Handler h = new Handler(Looper.getMainLooper());

    private static final int BG = Color.rgb(12, 14, 12), FG = Color.rgb(230, 235, 225), ACC = Color.rgb(200, 255, 62);

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(18);
        col.setPadding(pad, pad, pad, pad);
        col.setBackgroundColor(BG);

        TextView title = text("JC HELPER", 26, ACC);
        title.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        col.addView(title);
        col.addView(text("Ei phone ta PC-r router-er Wi-Fi te rakho, charger-e lagiye. App ta background-e chole, PC Power On korte magic packet pathay.", 14, Color.GRAY));

        tStatus = text("", 18, FG);
        tStatus.setPadding(0, dp(14), 0, dp(6));
        col.addView(tStatus);

        eServer = field(col, "Server (wss://...)", InputType.TYPE_TEXT_VARIATION_URI);
        eToken = field(col, "Token", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        eName = field(col, "Ei phone-er naam", InputType.TYPE_CLASS_TEXT);
        eMac = field(col, "PC MAC (optional)", InputType.TYPE_CLASS_TEXT);

        SharedPreferences p = HelperService.prefs(this);
        eServer.setText(p.getString("server", "wss://phone-pc-remote-0s5u.onrender.com"));
        eToken.setText(p.getString("token", ""));
        eName.setText(p.getString("name", "helper-" + Build.MODEL));
        eMac.setText(p.getString("mac", ""));

        col.addView(button("SAVE + START", true, v -> { save(); start(); }));
        col.addView(button("STOP", false, v -> stopService(new Intent(this, HelperService.class))));
        tBattery = text("", 13, Color.GRAY);
        tBattery.setPadding(0, dp(14), 0, 0);
        col.addView(tBattery);
        col.addView(button("BATTERY RESTRICTION BONDHO KORO", false, v -> askBattery()));
        col.addView(button("TEST: MAGIC PACKET PATHAO", false, v -> testWake()));

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(BG);
        sv.addView(col);
        setContentView(sv);

        handleLink(getIntent());
        if (!p.getString("token", "").isEmpty()) start();
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handleLink(i);
    }

    /** jchelper://setup?server=...&token=...&mac=... from the remote web app's settings */
    private void handleLink(Intent i) {
        Uri u = i == null ? null : i.getData();
        if (u == null || !"jchelper".equals(u.getScheme())) return;
        String s = u.getQueryParameter("server"), t = u.getQueryParameter("token"), m = u.getQueryParameter("mac");
        if (s != null && !s.isEmpty()) eServer.setText(s);
        if (t != null && !t.isEmpty()) eToken.setText(t);
        if (m != null && !m.isEmpty()) eMac.setText(m);
        save();
        stopService(new Intent(this, HelperService.class));
        h.postDelayed(this::start, 600);
        Toast.makeText(this, "Setup hoye geche", Toast.LENGTH_SHORT).show();
    }

    private void save() {
        HelperService.prefs(this).edit()
                .putString("server", eServer.getText().toString().trim())
                .putString("token", eToken.getText().toString().trim())
                .putString("name", eName.getText().toString().trim())
                .putString("mac", eMac.getText().toString().trim())
                .apply();
    }

    private void start() {
        Intent i = new Intent(this, HelperService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
    }

    private void askBattery() {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void testWake() {
        save();
        final byte[] mac = HelperService.parseMac(eMac.getText().toString());
        if (mac == null) {
            Toast.makeText(this, "PC MAC dao (AA:BB:CC:DD:EE:FF)", Toast.LENGTH_LONG).show();
            return;
        }
        new Thread(() -> {
            String r;
            try {
                HelperService.sendMagic(mac);
                r = "Magic packet pathano hoyeche";
            } catch (Exception e) {
                r = "Hoyni: " + e.getMessage();
            }
            final String msg = r;
            h.post(() -> Toast.makeText(this, msg, Toast.LENGTH_LONG).show());
        }).start();
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            String s = HelperService.status;
            if (!HelperService.lastWake.isEmpty()) s += "\nShesh Power On: " + HelperService.lastWake;
            tStatus.setText(s);
            PowerManager pm = getSystemService(PowerManager.class);
            boolean free = Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(getPackageName());
            tBattery.setText(free ? "Battery restriction: bondho ✓" : "Battery restriction: CHALU - niche chape bondho koro, na hole phone ghumale app bondho hobe");
            h.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onResume() {
        super.onResume();
        h.post(tick);
    }

    @Override
    protected void onPause() {
        super.onPause();
        h.removeCallbacks(tick);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    private EditText field(LinearLayout col, String hint, int type) {
        TextView l = text(hint, 12, Color.GRAY);
        l.setPadding(0, dp(10), 0, 0);
        col.addView(l);
        EditText e = new EditText(this);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextColor(FG);
        e.setHintTextColor(Color.DKGRAY);
        col.addView(e);
        return e;
    }

    private Button button(String label, boolean accent, View.OnClickListener l) {
        Button btn = new Button(this);
        btn.setText(label);
        btn.setAllCaps(false);
        btn.setTextColor(accent ? Color.BLACK : FG);
        btn.setBackgroundColor(accent ? ACC : Color.rgb(34, 38, 34));
        btn.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(10);
        btn.setLayoutParams(lp);
        btn.setOnClickListener(l);
        return btn;
    }
}
