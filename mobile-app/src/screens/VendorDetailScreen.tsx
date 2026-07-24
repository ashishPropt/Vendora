import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, TextInput, Linking,
} from 'react-native';
import { apiFetch } from '../services/api';

export default function VendorDetailScreen({ route, navigation }: any) {
  const vendor = route.params?.vendor;
  const [callType, setCallType] = useState<'onboarding' | 'quote'>('onboarding');
  const [description, setDescription] = useState('');
  const [calling, setCalling] = useState(false);

  if (!vendor) return <Text style={styles.emptyText}>No vendor data</Text>;

  async function makeCall() {
    if (callType === 'quote' && !description.trim()) {
      Alert.alert('Description required', 'Please describe the maintenance issue.');
      return;
    }

    Alert.alert(
      'Confirm Call',
      `Call ${vendor.canonical_name} (${callType})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Call Now',
          onPress: async () => {
            setCalling(true);
            try {
              const endpoint = callType === 'quote' ? '/admin/call-vendor-quote' : '/admin/call-vendor';
              const body = callType === 'quote'
                ? { vendor_id: vendor.vendor_id, description }
                : { vendor_id: vendor.vendor_id };
              const res = await apiFetch(endpoint, {
                method: 'POST',
                body: JSON.stringify(body),
              });
              const data = await res.json();
              if (!res.ok) {
                Alert.alert('Call Failed', data.error || 'Could not start call');
              } else {
                Alert.alert('Call Started', `Call ID: ${data.call_id}\nThe AI agent is now calling ${vendor.canonical_name}.`);
              }
            } catch (e: any) {
              Alert.alert('Error', e.message);
            }
            setCalling(false);
          },
        },
      ]
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.name}>{vendor.canonical_name}</Text>
        <Text style={styles.category}>{vendor.category_display_name || '—'}</Text>

        <View style={styles.infoRow}>
          <Text style={styles.label}>Phone</Text>
          <TouchableOpacity onPress={() => Linking.openURL(`tel:${vendor.primary_phone}`)}>
            <Text style={styles.link}>{vendor.primary_phone}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.infoRow}>
          <Text style={styles.label}>Location</Text>
          <Text style={styles.value}>
            {vendor.city || '—'}{vendor.state ? `, ${vendor.state}` : ''}
          </Text>
        </View>

        <View style={styles.infoRow}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.value}>{vendor.lifecycle_status || '—'}</Text>
        </View>

        <View style={styles.infoRow}>
          <Text style={styles.label}>Last Call</Text>
          <Text style={styles.value}>
            {vendor.last_call_outcome || 'None'}{' '}
            {vendor.last_call_at ? `· ${new Date(vendor.last_call_at).toLocaleDateString()}` : ''}
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Make AI Call</Text>

        <View style={styles.typeRow}>
          <TouchableOpacity
            style={[styles.typeBtn, callType === 'onboarding' && styles.typeBtnActive]}
            onPress={() => setCallType('onboarding')}
          >
            <Text style={[styles.typeText, callType === 'onboarding' && styles.typeTextActive]}>
              Onboarding
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.typeBtn, callType === 'quote' && styles.typeBtnActive]}
            onPress={() => setCallType('quote')}
          >
            <Text style={[styles.typeText, callType === 'quote' && styles.typeTextActive]}>
              Quote Request
            </Text>
          </TouchableOpacity>
        </View>

        {callType === 'quote' && (
          <TextInput
            style={styles.descInput}
            placeholder="Describe the maintenance issue..."
            placeholderTextColor="#64748b"
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={3}
          />
        )}

        <TouchableOpacity
          style={[styles.callBtn, calling && styles.callBtnDisabled]}
          onPress={makeCall}
          disabled={calling}
        >
          {calling ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.callBtnText}>📞 {callType === 'quote' ? 'Request Quote' : 'Start Onboarding Call'}</Text>
          )}
        </TouchableOpacity>
      </View>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  card: {
    backgroundColor: '#1e293b', margin: 16, borderRadius: 12,
    padding: 20, marginBottom: 8,
  },
  name: { fontSize: 22, fontWeight: '700', color: '#f8fafc', marginBottom: 4 },
  category: { fontSize: 14, color: '#3b82f6', marginBottom: 16 },
  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#334155',
  },
  label: { fontSize: 14, color: '#94a3b8' },
  value: { fontSize: 14, color: '#f8fafc', fontWeight: '500' },
  link: { fontSize: 14, color: '#3b82f6', fontWeight: '500' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#f8fafc', marginBottom: 16 },
  typeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  typeBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8,
    backgroundColor: '#0f172a', alignItems: 'center',
  },
  typeBtnActive: { backgroundColor: '#2563eb' },
  typeText: { fontSize: 14, fontWeight: '600', color: '#94a3b8' },
  typeTextActive: { color: '#fff' },
  descInput: {
    backgroundColor: '#0f172a', borderRadius: 8, padding: 12,
    fontSize: 14, color: '#f8fafc', borderWidth: 1, borderColor: '#334155',
    textAlignVertical: 'top', marginBottom: 12, minHeight: 80,
  },
  callBtn: {
    backgroundColor: '#16a34a', borderRadius: 10, padding: 14, alignItems: 'center',
  },
  callBtnDisabled: { opacity: 0.6 },
  callBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 60, fontSize: 14 },
});
