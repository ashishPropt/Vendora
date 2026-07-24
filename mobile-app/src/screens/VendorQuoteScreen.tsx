import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, Alert, ActivityIndicator,
} from 'react-native';
import { apiFetch } from '../services/api';

export default function VendorQuoteScreen({ route, navigation }: any) {
  const { job } = route.params;
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const alreadyQuoted = job.vendor_status === 'quoted';

  async function submitQuote() {
    if (!amount.trim() || !message.trim()) {
      Alert.alert('Required', 'Please enter both a price and a message.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/vendor/quote-requests/${job.id}/quote`, {
        method: 'POST',
        body: JSON.stringify({ amount: parseFloat(amount), message: message.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit quote');
      Alert.alert('Quote Submitted', 'Your quote has been sent successfully!', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
    setSubmitting(false);
  }

  function InfoRow({ label, value }: { label: string; value?: string }) {
    if (!value) return null;
    return (
      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <View style={styles.card}>
        <Text style={styles.category}>{job.category_label}</Text>
        <InfoRow label="Address" value={`${job.address}, ${job.city}, ${job.state}`} />
        <InfoRow label="Property" value={job.property_type} />
        <InfoRow label="Urgency" value={job.urgency} />
        <InfoRow label="Requested by" value={job.requester_name} />
        {job.description ? (
          <View style={styles.descBlock}>
            <Text style={styles.infoLabel}>Description</Text>
            <Text style={styles.descText}>{job.description}</Text>
          </View>
        ) : null}
      </View>

      {alreadyQuoted ? (
        <View style={styles.quotedCard}>
          <Text style={styles.quotedTitle}>✅ You've already quoted this job</Text>
          <InfoRow label="Your price" value={`$${job.quoted_amount}`} />
          <InfoRow label="Your message" value={job.quote_message} />
          <Text style={styles.quotedDate}>
            Submitted {job.quoted_at ? new Date(job.quoted_at).toLocaleDateString() : ''}
          </Text>
        </View>
      ) : (
        <View style={styles.quoteForm}>
          <Text style={styles.formTitle}>Submit Your Quote</Text>

          <Text style={styles.fieldLabel}>Your Price ($)</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. 350"
            placeholderTextColor="#475569"
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
          />

          <Text style={styles.fieldLabel}>Message to Customer</Text>
          <TextInput
            style={[styles.input, styles.textarea]}
            placeholder="Describe your approach, availability, and any questions..."
            placeholderTextColor="#475569"
            multiline
            numberOfLines={5}
            value={message}
            onChangeText={setMessage}
            textAlignVertical="top"
          />

          <TouchableOpacity
            style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
            onPress={submitQuote}
            disabled={submitting}
          >
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitBtnText}>Send Quote</Text>}
          </TouchableOpacity>
        </View>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  card: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, marginBottom: 16 },
  category: { fontSize: 20, fontWeight: '800', color: '#f8fafc', marginBottom: 14 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#334155' },
  infoLabel: { fontSize: 12, color: '#64748b', fontWeight: '600' },
  infoValue: { fontSize: 13, color: '#cbd5e1', flex: 1, textAlign: 'right', marginLeft: 16 },
  descBlock: { paddingTop: 10 },
  descText: { fontSize: 14, color: '#cbd5e1', lineHeight: 20, marginTop: 6 },
  quotedCard: { backgroundColor: '#14532d', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#16a34a' },
  quotedTitle: { fontSize: 15, fontWeight: '700', color: '#4ade80', marginBottom: 12 },
  quotedDate: { fontSize: 11, color: '#4ade80', marginTop: 8, opacity: 0.7 },
  quoteForm: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16 },
  formTitle: { fontSize: 17, fontWeight: '700', color: '#f8fafc', marginBottom: 16 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#94a3b8', marginBottom: 6, textTransform: 'uppercase' },
  input: {
    backgroundColor: '#0f172a', borderWidth: 1.5, borderColor: '#334155', borderRadius: 8,
    padding: 12, fontSize: 15, color: '#f8fafc', marginBottom: 16,
  },
  textarea: { height: 120, textAlignVertical: 'top' },
  submitBtn: { backgroundColor: '#2563eb', borderRadius: 10, padding: 16, alignItems: 'center', marginTop: 4 },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
