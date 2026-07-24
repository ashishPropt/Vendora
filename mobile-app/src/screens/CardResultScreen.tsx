import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator, Image,
} from 'react-native';
import { apiFetch } from '../services/api';
import { BusinessCard } from '../types';

export default function CardResultScreen({ route, navigation }: any) {
  const { card: initialCard, imageUri } = route.params;
  const [card, setCard] = useState<BusinessCard>(initialCard);
  const [saving, setSaving] = useState(false);

  function updateField(key: keyof BusinessCard, value: string) {
    setCard({ ...card, [key]: value });
  }

  async function saveVendor() {
    if (!card.company && !card.name) {
      Alert.alert('Missing Info', 'At least a company name or contact name is required.');
      return;
    }
    if (!card.phone) {
      Alert.alert('Missing Phone', 'A phone number is required to create a vendor.');
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch('/admin/vendors/upsert', {
        method: 'POST',
        body: JSON.stringify({
          canonical_name: card.company || card.name,
          primary_phone: card.phone,
          email: card.email,
          city: card.city || 'Unknown',
          state: card.state || 'NJ',
          zip: card.zip,
          website_url: card.website,
          primary_category_code: card.category || 'GEN.GEN',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        Alert.alert('Save Failed', data.error || 'Could not create vendor');
      } else {
        Alert.alert('Vendor Created', `${card.company || card.name} has been added!`, [
          { text: 'OK', onPress: () => navigation.popToTop() },
        ]);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
    setSaving(false);
  }

  function Field({ label, field, placeholder, keyboard }: {
    label: string; field: keyof BusinessCard; placeholder?: string; keyboard?: any;
  }) {
    return (
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <TextInput
          style={styles.fieldInput}
          value={card[field] || ''}
          onChangeText={(v) => updateField(field, v)}
          placeholder={placeholder || label}
          placeholderTextColor="#475569"
          keyboardType={keyboard || 'default'}
        />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {imageUri && (
        <Image source={{ uri: imageUri }} style={styles.cardImage} resizeMode="contain" />
      )}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Extracted Info</Text>
        <Text style={styles.hint}>Review and edit before saving</Text>

        <Field label="Company Name" field="company" />
        <Field label="Contact Name" field="name" />
        <Field label="Phone" field="phone" keyboard="phone-pad" />
        <Field label="Email" field="email" keyboard="email-address" />
        <Field label="Address" field="address" />
        <Field label="City" field="city" />
        <Field label="State" field="state" />
        <Field label="Zip" field="zip" keyboard="numeric" />
        <Field label="Website" field="website" keyboard="url" />
        <Field label="Category / Trade" field="category" placeholder="e.g. Plumbing, Electrical" />
      </View>

      <TouchableOpacity
        style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
        onPress={saveVendor}
        disabled={saving}
      >
        {saving ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.saveBtnText}>✅ Create Vendor</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.cancelBtn}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.cancelBtnText}>Cancel</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  cardImage: {
    height: 160, marginHorizontal: 16, marginTop: 8,
    borderRadius: 10, backgroundColor: '#1e293b',
  },
  card: {
    backgroundColor: '#1e293b', margin: 16, borderRadius: 12, padding: 20,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#f8fafc' },
  hint: { fontSize: 12, color: '#64748b', marginBottom: 16 },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#94a3b8', marginBottom: 4 },
  fieldInput: {
    backgroundColor: '#0f172a', borderRadius: 8, padding: 12,
    fontSize: 15, color: '#f8fafc', borderWidth: 1, borderColor: '#334155',
  },
  saveBtn: {
    backgroundColor: '#16a34a', marginHorizontal: 16, borderRadius: 10,
    padding: 16, alignItems: 'center',
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  cancelBtn: { alignItems: 'center', marginTop: 12 },
  cancelBtnText: { color: '#64748b', fontSize: 14 },
});
