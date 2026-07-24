import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { login } from '../services/api';

export default function LoginScreen({ onLogin, navigation }: { onLogin?: (role: 'admin' | 'vendor') => void } & any) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (!email.trim() || !password.trim()) return;
    setLoading(true);
    setError('');
    const result = await login(email.trim(), password);
    setLoading(false);
    if (result.success && result.role) {
      onLogin?.(result.role);
    } else {
      setError(result.error || 'Login failed');
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.card}>
        <Text style={styles.logo}>🏗️</Text>
        <Text style={styles.title}>Vendora</Text>
        <Text style={styles.subtitle}>Sign in to continue</Text>

        <TextInput
          style={styles.input}
          placeholder="Email address"
          placeholderTextColor="#475569"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          value={email}
          onChangeText={setEmail}
          returnKeyType="next"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#475569"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={handleLogin}
          autoCapitalize="none"
          returnKeyType="go"
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={loading}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.signupLink} onPress={() => navigation?.navigate('SignUp')}>
          <Text style={styles.signupLinkText}>New vendor? <Text style={styles.signupLinkBold}>Create account</Text></Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 360, backgroundColor: '#1e293b', borderRadius: 16, padding: 32, alignItems: 'center' },
  logo: { fontSize: 48, marginBottom: 4 },
  title: { fontSize: 28, fontWeight: '700', color: '#f8fafc', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#94a3b8', marginBottom: 28 },
  input: {
    width: '100%', backgroundColor: '#0f172a', borderWidth: 1.5, borderColor: '#334155',
    borderRadius: 10, padding: 14, fontSize: 15, color: '#f8fafc', marginBottom: 14,
  },
  error: { color: '#f87171', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  button: { width: '100%', backgroundColor: '#2563eb', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 4 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  signupLink: { marginTop: 20 },
  signupLinkText: { color: '#64748b', fontSize: 14 },
  signupLinkBold: { color: '#2563eb', fontWeight: '600' },
});
