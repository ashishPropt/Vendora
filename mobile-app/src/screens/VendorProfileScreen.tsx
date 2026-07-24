import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch, logout } from '../services/api';

interface VendorProfile {
  // Business fields
  vendor_id: string;
  canonical_name: string;
  primary_phone: string;
  secondary_phone?: string;
  email?: string;
  website_url?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  primary_category_code?: string;
  years_in_business?: number;
  employee_count_range?: string;
  service_radius_miles?: number;
  is_licensed: boolean;
  is_insured: boolean;
  is_onboarded: boolean;
  // Portal user fields
  first_name: string;
  last_name: string;
  portal_email: string;
}

interface FormState {
  canonical_name: string;
  first_name: string;
  last_name: string;
  primary_phone: string;
  email: string;
  website_url: string;
  street_address: string;
  city: string;
  state: string;
  zip: string;
  years_in_business: string;
  employee_count_range: string;
}

export default function VendorProfileScreen({ onLogout }: { onLogout?: () => void } & any) {
  const [profile, setProfile] = useState<VendorProfile | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [form, setForm] = useState<FormState>({
    canonical_name: '', first_name: '', last_name: '',
    primary_phone: '', email: '', website_url: '',
    street_address: '', city: '', state: '', zip: '',
    years_in_business: '', employee_count_range: '',
  });

  async function loadProfile() {
    try {
      const res = await apiFetch('/vendor/profile');
      if (res.ok) {
        const p = await res.json();
        setProfile({ ...p, portal_email: p.email });
        setForm({
          canonical_name: p.canonical_name || '',
          first_name: p.first_name || '',
          last_name: p.last_name || '',
          primary_phone: p.primary_phone || '',
          email: p.email || '',
          website_url: p.website_url || '',
          street_address: p.street_address || '',
          city: p.city || '',
          state: p.state || '',
          zip: p.zip || '',
          years_in_business: p.years_in_business ? String(p.years_in_business) : '',
          employee_count_range: p.employee_count_range || '',
        });
      }
    } catch {}
  }

  useFocusEffect(useCallback(() => {
    loadProfile();
  }, []));

  async function handleScanCard() {
    // Ask camera vs gallery
    const source = await new Promise<'camera' | 'gallery' | null>(resolve => {
      Alert.alert('Scan Business Card', 'Choose image source', [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: '🖼️ Gallery', onPress: () => resolve('gallery') },
        { text: '📷 Camera', onPress: () => resolve('camera') },
      ]);
    });
    if (!source) return;

    if (source === 'camera') {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please grant camera access.');
        return;
      }
    } else {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please grant photo library access.');
        return;
      }
    }

    const result = await (source === 'camera'
      ? ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.25, base64: true, exif: false })
      : ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.5, base64: true }));
    if (result.canceled || !result.assets[0]) return;

    setScanning(true);
    try {
      // Step 1: extract card data via Claude vision (60s timeout)
      const b64 = result.assets[0].base64;
      if (!b64) throw new Error('Could not read image data. Please try again.');
      const scanRes = await apiFetch('/vendor/scan-card', { method: 'POST', body: JSON.stringify({ image: b64 }) }, 60000);
      if (!scanRes.ok) {
        const e = await scanRes.json();
        throw new Error(e.error || 'Scan failed');
      }
      const card = await scanRes.json();
      setScanning(false);

      // Step 2: show extracted data, ask user to confirm before matching
      const preview = [
        card.company && `Business: ${card.company}`,
        card.name && `Contact: ${card.name}`,
        card.phone && `Phone: ${card.phone}`,
        card.city && `City: ${card.city}`,
      ].filter(Boolean).join('\n');

      Alert.alert(
        'Card Extracted',
        preview + '\n\nLink this to your account?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Link Account',
            onPress: async () => {
              setScanning(true);
              try {
                // Step 3: match or create vendor (text-only, fast)
                const matchRes = await apiFetch('/vendor/match-or-create', {
                  method: 'POST',
                  body: JSON.stringify(card),
                }, 20000);
                if (!matchRes.ok) {
                  const e = await matchRes.json();
                  throw new Error(e.error || 'Match failed');
                }
                const { matched, vendor } = await matchRes.json();
                Alert.alert(
                  matched ? '✅ Business Found' : '🏢 New Business Created',
                  matched
                    ? `Linked to existing business: "${vendor.canonical_name}"`
                    : `Created new profile for "${vendor.canonical_name}". Review and save any corrections.`,
                );
                await loadProfile();
                setEditing(false);
              } catch (e: any) {
                Alert.alert('Error', e.message);
              }
              setScanning(false);
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('Scan Failed', e.message || 'Could not read the business card.');
      setScanning(false);
    }
  }

  async function saveProfile() {
    setSaving(true);
    try {
      const body = {
        canonical_name: form.canonical_name || undefined,
        primary_phone: form.primary_phone || undefined,
        email: form.email || undefined,
        website_url: form.website_url || undefined,
        street_address: form.street_address || undefined,
        city: form.city || undefined,
        state: form.state || undefined,
        zip: form.zip || undefined,
        years_in_business: form.years_in_business ? Number(form.years_in_business) : undefined,
        employee_count_range: form.employee_count_range || undefined,
      };
      const res = await apiFetch('/vendor/profile', { method: 'PUT', body: JSON.stringify(body) });
      if (res.ok) {
        await loadProfile();
        setEditing(false);
        Alert.alert('Saved', 'Profile updated.');
      } else {
        const d = await res.json();
        Alert.alert('Error', d.error || 'Failed to save');
      }
    } catch {
      Alert.alert('Error', 'Network error');
    }
    setSaving(false);
  }

  function handleLogout() {
    Alert.alert('Logout', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: async () => { await logout(); onLogout?.(); } },
    ]);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Business Profile</Text>
            {profile?.primary_category_code && (
              <Text style={styles.categoryBadge}>{profile.primary_category_code}</Text>
            )}
          </View>
          {!editing && (
            <TouchableOpacity onPress={() => setEditing(true)}>
              <Text style={styles.editBtn}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {editing ? (
          <View style={styles.card}>
            {/* Scan Button — hidden once profile has business name and phone (means card was already scanned) */}
            {!(profile?.canonical_name && profile?.primary_phone) && (
              <>
                <TouchableOpacity
                  style={[styles.scanBtn, scanning && { opacity: 0.6 }]}
                  onPress={handleScanCard}
                  disabled={scanning}
                >
                  {scanning
                    ? <><ActivityIndicator color="#93c5fd" size="small" /><Text style={styles.scanBtnText}>  Scanning & Matching...</Text></>
                    : <Text style={styles.scanBtnText}>📷  Scan Business Card</Text>}
                </TouchableOpacity>
                <Text style={styles.scanHint}>Auto-fills fields and links you to an existing business if found</Text>
              </>
            )}

            <SectionLabel label="Business" />
            <Field label="Business Name" value={form.canonical_name} onChange={v => setForm({ ...form, canonical_name: v })} />
            <Field label="Phone" value={form.primary_phone} onChange={v => setForm({ ...form, primary_phone: v })} keyboard="phone-pad" />
            <Field label="Business Email" value={form.email} onChange={v => setForm({ ...form, email: v })} keyboard="email-address" caps="none" />
            <Field label="Website" value={form.website_url} onChange={v => setForm({ ...form, website_url: v })} keyboard="url" caps="none" />

            <SectionLabel label="Address" />
            <Field label="Street Address" value={form.street_address} onChange={v => setForm({ ...form, street_address: v })} />
            <View style={styles.row}>
              <View style={{ flex: 2, marginRight: 8 }}>
                <Field label="City" value={form.city} onChange={v => setForm({ ...form, city: v })} />
              </View>
              <View style={{ flex: 1, marginRight: 8 }}>
                <Field label="State" value={form.state} onChange={v => setForm({ ...form, state: v })} caps="characters" />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="ZIP" value={form.zip} onChange={v => setForm({ ...form, zip: v })} keyboard="numeric" />
              </View>
            </View>

            <SectionLabel label="Details" />
            <Field label="Years in Business" value={form.years_in_business} onChange={v => setForm({ ...form, years_in_business: v })} keyboard="numeric" />
            <Field label="Team Size" value={form.employee_count_range} onChange={v => setForm({ ...form, employee_count_range: v })} placeholder="e.g. 1-5, 6-20" />

            <View style={styles.editButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditing(false)}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={saveProfile} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        ) : profile ? (
          <>
            {/* Business card */}
            <View style={styles.card}>
              <Text style={styles.businessName}>{profile.canonical_name || 'No business name set'}</Text>
              {(profile.first_name || profile.last_name) && (
                <Text style={styles.contactName}>Contact: {[profile.first_name, profile.last_name].filter(Boolean).join(' ')}</Text>
              )}
              <View style={styles.badges}>
                {profile.is_licensed && <Badge label="Licensed" color="#16a34a" />}
                {profile.is_insured && <Badge label="Insured" color="#2563eb" />}
                {profile.is_onboarded && <Badge label="Active" color="#7c3aed" />}
              </View>
            </View>

            {/* Contact info */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Contact</Text>
              <InfoRow label="Phone" value={profile.primary_phone} />
              <InfoRow label="Email" value={profile.email} />
              <InfoRow label="Website" value={profile.website_url} />
            </View>

            {/* Location */}
            {(profile.street_address || profile.city) && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Location</Text>
                {profile.street_address && <InfoRow label="Address" value={profile.street_address} />}
                {(profile.city || profile.state) && (
                  <InfoRow label="City" value={[profile.city, profile.state, profile.zip].filter(Boolean).join(', ')} />
                )}
              </View>
            )}

            {/* Business details */}
            {(profile.years_in_business || profile.employee_count_range || profile.service_radius_miles) && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>Details</Text>
                {profile.years_in_business ? <InfoRow label="In Business" value={`${profile.years_in_business} years`} /> : null}
                {profile.employee_count_range ? <InfoRow label="Team Size" value={profile.employee_count_range} /> : null}
                {profile.service_radius_miles ? <InfoRow label="Service Radius" value={`${profile.service_radius_miles} miles`} /> : null}
              </View>
            )}
          </>
        ) : (
          <View style={styles.card}><ActivityIndicator color="#2563eb" /></View>
        )}

        <View style={styles.card}>
          <InfoRow label="Login Email" value={profile?.portal_email} />
          <InfoRow label="Server" value="vendora.leaseloft.ai" />
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SectionLabel({ label }: { label: string }) {
  return <Text style={styles.sectionLabel}>{label.toUpperCase()}</Text>;
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color + '44' }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function Field({ label, value, onChange, keyboard, caps, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  keyboard?: any; caps?: any; placeholder?: string;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholderTextColor="#475569"
        keyboardType={keyboard || 'default'}
        autoCapitalize={caps || 'words'}
        placeholder={placeholder || label}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  title: { fontSize: 26, fontWeight: '800', color: '#f8fafc' },
  categoryBadge: { fontSize: 12, color: '#64748b', marginTop: 2 },
  editBtn: { color: '#2563eb', fontSize: 15, fontWeight: '600' },
  card: { backgroundColor: '#1e293b', marginHorizontal: 16, borderRadius: 12, padding: 20, marginBottom: 14 },

  // Business display
  businessName: { fontSize: 22, fontWeight: '800', color: '#f8fafc', marginBottom: 4 },
  contactName: { fontSize: 14, color: '#94a3b8', marginBottom: 10 },
  badges: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, borderWidth: 1 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },

  // Info rows
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#1e3a5f22' },
  infoLabel: { fontSize: 13, color: '#64748b', flex: 1 },
  infoValue: { fontSize: 13, color: '#f8fafc', flex: 2, textAlign: 'right', marginLeft: 8 },

  // Scan button
  scanBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1e3a5f', borderRadius: 10, padding: 14, marginBottom: 6, borderWidth: 1, borderColor: '#2563eb' },
  scanBtnText: { color: '#93c5fd', fontSize: 15, fontWeight: '700' },
  scanHint: { fontSize: 11, color: '#475569', textAlign: 'center', marginBottom: 18, lineHeight: 15 },

  // Edit form
  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#475569', letterSpacing: 1, marginTop: 14, marginBottom: 6 },
  row: { flexDirection: 'row' },
  fieldWrap: { marginBottom: 12 },
  fieldLabel: { fontSize: 11, fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', marginBottom: 5 },
  fieldInput: {
    backgroundColor: '#0f172a', borderWidth: 1.5, borderColor: '#334155', borderRadius: 8,
    padding: 11, fontSize: 14, color: '#f8fafc',
  },
  editButtons: { flexDirection: 'row', gap: 10, marginTop: 16 },
  cancelBtn: { flex: 1, backgroundColor: '#334155', borderRadius: 8, padding: 12, alignItems: 'center' },
  cancelText: { color: '#94a3b8', fontWeight: '600' },
  saveBtn: { flex: 2, backgroundColor: '#2563eb', borderRadius: 8, padding: 12, alignItems: 'center' },
  saveText: { color: '#fff', fontWeight: '700' },

  logoutBtn: { backgroundColor: '#dc2626', marginHorizontal: 16, borderRadius: 10, padding: 14, alignItems: 'center' },
  logoutText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
