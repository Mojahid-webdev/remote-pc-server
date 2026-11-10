package com.mojahid.jchelper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Always-on connection to the relay. When the phone app asks for "Power On", broadcast a Wake-on-LAN magic packet. */
public class HelperService extends Service {
    static final String CH = "jc_helper";
    static volatile String status = "Bondho";
    static volatile String lastWake = "";
    static volatile boolean running = false;

    private final Handler h = new Handler(Looper.getMainLooper());
    private OkHttpClient client;
    private WebSocket ws;
    private PowerManager.WakeLock wl;
    private WifiManager.WifiLock wifiLock;
    private long delay = 2000;
    private long lastSeen = 0;
    private boolean stopping = false;

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("cfg", MODE_PRIVATE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CH, "JC Helper", NotificationManager.IMPORTANCE_LOW));
        }
        client = new OkHttpClient.Builder()
                .pingInterval(25, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
    }

    private Notification note(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        return b.setContentTitle("JC Helper")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_lock_power_off)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    private void setStatus(String s) {
        status = s;
        try {
            getSystemService(NotificationManager.class).notify(1, note(s));
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, note("Connecting..."), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(1, note("Connecting..."));
        }
        if (!running) {
            running = true;
            stopping = false;
            PowerManager pm = getSystemService(PowerManager.class);
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "jchelper:conn");
            wl.acquire();
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "jchelper:wifi");
            wifiLock.acquire();
            connect();
            h.postDelayed(keepAlive, 25000);
        }
        return START_STICKY;
    }

    private final Runnable keepAlive = new Runnable() {
        @Override
        public void run() {
            if (stopping) return;
            WebSocket w = ws;
            if (w != null) {
                if (lastSeen > 0 && System.currentTimeMillis() - lastSeen > 75000) {
                    w.cancel(); // dead connection: onFailure reconnects
                } else {
                    // a real message keeps the free Render service awake
                    w.send("{\"t\":\"ping\",\"ts\":" + System.currentTimeMillis() + "}");
                }
            }
            h.postDelayed(this, 25000);
        }
    };

    private void connect() {
        if (stopping) return;
        SharedPreferences p = prefs(this);
        String server = p.getString("server", "").trim();
        String token = p.getString("token", "").trim();
        if (server.isEmpty() || token.isEmpty()) {
            setStatus("Setup baki: server ar token dao");
            return;
        }
        if (server.endsWith("/")) server = server.substring(0, server.length() - 1);
        if (!server.endsWith("/ws")) server += "/ws";
        setStatus("Connecting...");
        Request req;
        try {
            req = new Request.Builder().url(server).build();
        } catch (Exception e) {
            setStatus("Server address bhul");
            return;
        }
        final String tok = token;
        final String name = p.getString("name", "helper-phone");
        ws = client.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket w, Response r) {
                lastSeen = System.currentTimeMillis();
                try {
                    JSONObject o = new JSONObject();
                    o.put("t", "auth");
                    o.put("token", tok);
                    o.put("role", "helper");
                    o.put("name", name);
                    w.send(o.toString());
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onMessage(WebSocket w, String text) {
                lastSeen = System.currentTimeMillis();
                try {
                    JSONObject m = new JSONObject(text);
                    String t = m.optString("t");
                    if ("auth".equals(t)) {
                        if (m.optBoolean("ok")) {
                            delay = 2000;
                            setStatus("Online - Power On er jonno ready");
                        } else {
                            setStatus("Token bhul");
                        }
                    } else if ("wake".equals(t)) {
                        final String id = m.optString("id");
                        String mac = m.optString("mac");
                        if (parseMac(mac) == null) mac = prefs(HelperService.this).getString("mac", "");
                        final String fmac = mac;
                        new Thread(() -> {
                            JSONObject ack = new JSONObject();
                            try {
                                ack.put("t", "wake_ack");
                                ack.put("id", id);
                                byte[] mb = parseMac(fmac);
                                if (mb == null) {
                                    ack.put("ok", false);
                                    ack.put("error", "no valid MAC");
                                } else {
                                    sendMagic(mb);
                                    ack.put("ok", true);
                                    lastWake = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
                                }
                            } catch (Exception e) {
                                try {
                                    ack.put("ok", false);
                                    ack.put("error", String.valueOf(e.getMessage()));
                                } catch (Exception ignored) {
                                }
                            }
                            WebSocket cur = ws;
                            if (cur != null) cur.send(ack.toString());
                        }).start();
                    }
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onClosing(WebSocket w, int code, String reason) {
                w.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket w, int code, String reason) {
                retry(code == 4003 ? "Token bhul" : "Disconnected");
            }

            @Override
            public void onFailure(WebSocket w, Throwable t, Response r) {
                retry("Net nei / server ghumachche");
            }
        });
    }

    private void retry(String why) {
        if (stopping) return;
        ws = null;
        final long d = delay;
        setStatus(why + " - " + (d / 1000) + "s pore abar chesta");
        delay = Math.min(delay * 2, 30000);
        h.postDelayed(this::connect, d);
    }

    static byte[] parseMac(String s) {
        if (s == null) return null;
        String hex = s.replaceAll("[^0-9a-fA-F]", "");
        if (hex.length() != 12) return null;
        byte[] b = new byte[6];
        for (int i = 0; i < 6; i++) b[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return b;
    }

    static void sendMagic(byte[] mac) throws Exception {
        byte[] pkt = new byte[6 + 16 * 6];
        for (int i = 0; i < 6; i++) pkt[i] = (byte) 0xff;
        for (int i = 0; i < 16; i++) System.arraycopy(mac, 0, pkt, 6 + i * 6, 6);
        Set<InetAddress> targets = new LinkedHashSet<>();
        targets.add(InetAddress.getByName("255.255.255.255"));
        try {
            Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
            while (en != null && en.hasMoreElements()) {
                NetworkInterface ni = en.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null) targets.add(ia.getBroadcast());
                }
            }
        } catch (Exception ignored) {
        }
        try (DatagramSocket s = new DatagramSocket()) {
            s.setBroadcast(true);
            for (int round = 0; round < 3; round++) {
                for (InetAddress a : targets) {
                    for (int port : new int[]{9, 7}) {
                        try {
                            s.send(new DatagramPacket(pkt, pkt.length, a, port));
                        } catch (Exception ignored) {
                        }
                    }
                }
                Thread.sleep(250);
            }
        }
    }

    @Override
    public void onDestroy() {
        stopping = true;
        running = false;
        h.removeCallbacksAndMessages(null);
        if (ws != null) ws.close(1000, "stop");
        try {
            if (wl != null && wl.isHeld()) wl.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {
        }
        status = "Bondho";
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent i) {
        return null;
    }
}
