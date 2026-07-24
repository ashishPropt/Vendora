import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { apiFetch, saveToken } from '../services/api';

export default function SignUpScreen({ onLogin }: { onLogin: (role: 'admin' | 'vendor') => void } & any) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSignUp() {
    if (!firstName.trim() || !email.trim() || !password) {
      Alert.alert('Required', 'First name, email and password are required.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('Password Mismatch', 'Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Weak Password', 'Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, first_name: firstName.trim(), last_name: lastName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sign-up failed');
      await saveToken(data.token, 'vendor', data.user);
      onLogin('vendor');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
    setLoading(false);
  }

  return (
    <KeyboardAvoidingView style={styles.outer} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.logo}>V</Text>
          <Text style={styles.brand}>Vendora</Text>
          <Text style={styles.subtitle}>Create your vendor account</Text>
        </View>

        <View style={styles.card}>
          <View style={styles.row}>
            <View style={[styles.field, { flex: 1, marginRight: 8 }]}>
              <Text style={styles.label}>First Name *</Text>
              <TextInput style={styles.input} value={firstName} onChangeText={setFirstName}
                placeholder="Jane" placeholderTextColor="#475569" autoCapitalize="words" />
            </View>
            <View style={[styles.field, { flex: 1 }]}>
              <Text style={styles.label}>Last Name</Text>
              <TextInput style={styles.input} value={lastName} onChangeText={setLastName}
                placeholder="Smith" placeholderTextColor="#475569" autoCapitalize="words" />
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Email *</Text>
            <TextInput style={styles.input} value={email} onChangeText={setEmail}
              placeholder="jane@example.com" placeholderTextColor="#475569"
              keyboardType="email-address" autoCapitalize="none" autoCorrect={false} />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password *</Text>
            <TextInput style={styles.input} value={password} onChangeText={setPassword}
              placeholder="Min 8 characters" placeholderTextColor="#475569" secureTextEntry />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Confirm Password *</Text>
            <TextInput style={styles.input} value={confirm} onChangeText={setConfirm}
              placeholder="Repeat password" placeholderTextColor="#475569" secureTextEntry />
          </View>

          <TouchableOpacity style={[styles.btn, loading && styles.btnDisabled]} onPress={handleSignUp} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Create Account</Text>}
          </TouchableOpacity>

          <Text style={styles.note}>
            By signing up you're creating a vendor account. Admin and developer accounts are provisioned by Vendora staff.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, backgroundColor: '#0f172a' },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 32 },
  logo: { width: 56, height: 56, borderRadius: 16, backgroundColor: '#16a34a', textAlign: 'center', lineHeight: 56, fontSize: 28, fontWeight: '800', color: '#fff', overflow: 'hidden' },
  brand: { fontSize: 28, fontWeight: '800', color: '#f8fafc', marginTop: 12 },
  subtitle: { fontSize: 14, color: '#64748b', marginTop: 4 },
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 24 },
  row: { flexDirection: 'row' },
  field: { marginBottom: 16 },
  label: { fontSize: 12, fontWeight: '600', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 6 },
  input: {
    backgroundColor: '#0f172a', borderWidth: 1.5, borderColor: '#334155', borderRadius: 10,
    padding: 13, fontSize: 15, color: '#f8fafc',
  },
  btn: { backgroundColor: '#16a34a', borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  note: { fontSize: 12, color: '#475569', marginTop: 16, textAlign: 'center', lineHeight: 18 },
});
