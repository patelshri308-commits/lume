import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from "react-native";
import { WebView } from "react-native-webview";
import { Gyroscope } from "expo-sensors";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");

type Props = {
  onForgotPassword?: () => void;
};

export default function HomepageHero({ onForgotPassword }: Props) {
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [gyroAvailable, setGyroAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let sub: { remove: () => void } | null = null;

    Gyroscope.isAvailableAsync().then((available) => {
      setGyroAvailable(available);
      if (available) {
        Gyroscope.setUpdateInterval(16);
        sub = Gyroscope.addListener(({ x: gx, y: gy }) => {
          webViewRef.current?.postMessage(JSON.stringify({ x: gy * 2.5, y: gx * 2.5 }));
        });
      }
    });

    return () => { sub?.remove(); };
  }, []);

  const handleSignup = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signUp({ email: email.trim(), password });
    setMessage(error ? error.message : "Check your email to confirm your account.");
    setLoading(false);
  };

  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setMessage(error.message);
    setLoading(false);
  };

  const handleTouchMove = (event: any) => {
    const { locationX, locationY } = event.nativeEvent;
    const x = (locationX / SCREEN_W) * 2 - 1;
    const y = (locationY / SCREEN_H) * 2 - 1;
    webViewRef.current?.postMessage(JSON.stringify({ x, y }));
  };

  return (
    <View style={styles.root}>
      {/* Three.js background scene */}
      <WebView
        ref={webViewRef}
        source={require("../assets/lume_final.html") as any}
        style={styles.webview}
        originWhitelist={["*"]}
        allowFileAccess={true}
        javaScriptEnabled={true}
        scrollEnabled={false}
      />

      {/* Touch parallax fallback — only when gyroscope is unavailable */}
      {gyroAvailable === false && (
        <View
          style={StyleSheet.absoluteFill}
          pointerEvents="box-only"
          onTouchMove={handleTouchMove}
        />
      )}

      {/* Native UI overlay — box-none so empty areas pass touches through */}
      <View style={[StyleSheet.absoluteFill, styles.overlayZ]} pointerEvents="box-none">
        <KeyboardAvoidingView
          style={styles.keyboardAvoider}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          pointerEvents="box-none"
        >
          <View
            style={[styles.keyboardInner, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
            pointerEvents="box-none"
          >
            <View style={styles.logoArea} pointerEvents="none">
              <Text style={styles.wordmark}>Lume</Text>
              <Text style={styles.tagline}>Fuel your best days.</Text>
            </View>

            <View style={{ flex: 1 }} pointerEvents="none" />

            <View style={styles.form}>
              <TextInput
                style={styles.input}
                placeholder="Email"
                placeholderTextColor="rgba(26,26,20,0.4)"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                pointerEvents="auto"
              />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="rgba(26,26,20,0.4)"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="password"
                pointerEvents="auto"
              />

              {message ? <Text style={styles.message}>{message}</Text> : null}

              <TouchableOpacity
                style={[styles.btnPrimary, loading && styles.disabled]}
                onPress={handleSignup}
                activeOpacity={0.85}
                disabled={loading}
              >
                <Text style={styles.btnPrimaryText}>Get started free</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.btnSecondary, loading && styles.disabled]}
                onPress={handleLogin}
                activeOpacity={0.8}
                disabled={loading}
              >
                <Text style={styles.btnSecondaryText}>Sign in</Text>
              </TouchableOpacity>

              {onForgotPassword && (
                <TouchableOpacity
                  style={styles.forgotLink}
                  onPress={onForgotPassword}
                >
                  <Text style={styles.forgotText}>Forgot password?</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  webview: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
  },
  overlayZ: {
    zIndex: 1,
  },
  keyboardAvoider: {
    flex: 1,
  },
  keyboardInner: {
    flex: 1,
    paddingHorizontal: 28,
  },
  logoArea: {
    alignItems: "center",
    paddingTop: 56,
  },
  wordmark: {
    fontFamily: "Chillax-Bold",
    fontSize: 68,
    color: "#1A1A14",
    letterSpacing: -1.5,
    lineHeight: 76,
  },
  tagline: {
    fontFamily: "Chillax-Regular",
    fontSize: 17,
    color: "rgba(26,26,20,0.5)",
    marginTop: 6,
    letterSpacing: -0.2,
  },
  form: {
    paddingBottom: 12,
    gap: 12,
  },
  input: {
    height: 54,
    borderRadius: 100,
    backgroundColor: "rgba(250,250,247,0.85)",
    borderWidth: 1.5,
    borderColor: "rgba(227,213,23,0.4)",
    paddingHorizontal: 22,
    fontSize: 15,
    fontFamily: "Inter-Variable",
    color: "#1A1A14",
  },
  message: {
    fontFamily: "Inter-Variable",
    fontSize: 13,
    color: "#1A1A14",
    textAlign: "center",
    opacity: 0.7,
    marginBottom: 2,
  },
  btnPrimary: {
    height: 56,
    borderRadius: 100,
    backgroundColor: "#1A1A14",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#1A1A14",
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  btnPrimaryText: {
    fontFamily: "Chillax-Bold",
    fontSize: 16,
    color: "#E3D517",
    letterSpacing: 0.1,
  },
  btnSecondary: {
    height: 52,
    borderRadius: 100,
    backgroundColor: "rgba(227,213,23,0.12)",
    borderWidth: 1.5,
    borderColor: "rgba(227,213,23,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  btnSecondaryText: {
    fontFamily: "Chillax-Medium",
    fontSize: 16,
    color: "#1A1A14",
    letterSpacing: 0.1,
  },
  forgotLink: {
    alignSelf: "center",
    paddingVertical: 6,
  },
  forgotText: {
    fontFamily: "Inter-Variable",
    fontSize: 14,
    color: "rgba(26,26,20,0.55)",
  },
  disabled: {
    opacity: 0.6,
  },
});
