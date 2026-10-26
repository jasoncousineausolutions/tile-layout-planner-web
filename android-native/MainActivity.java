package com.jasoncousineausolutions.tileplanner;

import android.os.Bundle;
import java.io.File;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.Date;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(FileSaverPlugin.class);   // the Save dialog; must come before super.onCreate
        recordCrashes();
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.statusBars());
        controller.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    // Writes the Java error to a file just before the app closes; FileSaverPlugin.lastCrash shows it on the next start.
    private void recordCrashes() {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try (PrintWriter out = new PrintWriter(new FileWriter(new File(getFilesDir(), "last-crash.txt")))) {
                out.println(new Date() + " in thread " + thread.getName());
                error.printStackTrace(out);
            } catch (Throwable ignored) {
                // nothing more can be done
            }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }
}
