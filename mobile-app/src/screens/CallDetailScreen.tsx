import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { apiFetch } from '../services/api';

export default function CallDetailScreen({ route }: any) {
  const { call_id } = route.params;
  const [call, setCall] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/admin/calls/${call_id}/transcript`);
        const data = await res.json();
        setCall(data);
      } catch (e) {
        console.warn('Call detail failed:', e);
      }
      setLoading(false);
    })();
  }, [call_id]);

  if (loading) return <ActivityIndicator style={{ flex: 1 }} size="large" color="#3b82f6" />;
  if (!call) return <Text style={styles.emptyText}>Call not found</Text>;

  return (
    <ScrollView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.vendorName}>{call.vendor_name || call.canonical_name}</Text>
        <Text style={styles.callType}>
          {call.call_type === 'quote' ? '💬 Quote Request' : '📞 Onboarding'}
        </Text>

        <View style={styles.row}>
          <Text style={styles.label}>Status</Text>
          <Text style={styles.value}>{call.status}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Outcome</Text>
          <Text style={styles.value}>{call.outcome || '—'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Started</Text>
          <Text style={styles.value}>{new Date(call.initiated_at).toLocaleString()}</Text>
        </View>
        {call.ended_at && (
          <View style={styles.row}>
            <Text style={styles.label}>Ended</Text>
            <Text style={styles.value}>{new Date(call.ended_at).toLocaleString()}</Text>
          </View>
        )}
        {call.vendor_email && (
          <View style={styles.row}>
            <Text style={styles.label}>Email</Text>
            <Text style={[styles.value, { color: '#3b82f6' }]}>{call.vendor_email}</Text>
          </View>
        )}
      </View>

      {call.summary ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <Text style={styles.bodyText}>{call.summary}</Text>
        </View>
      ) : null}

      {call.transcript ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Transcript</Text>
          <Text style={styles.bodyText}>{call.transcript}</Text>
        </View>
      ) : null}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  card: {
    backgroundColor: '#1e293b', margin: 16, borderRadius: 12,
    padding: 20, marginBottom: 4,
  },
  vendorName: { fontSize: 20, fontWeight: '700', color: '#f8fafc' },
  callType: { fontSize: 14, color: '#3b82f6', marginTop: 4, marginBottom: 16 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#334155',
  },
  label: { fontSize: 14, color: '#94a3b8' },
  value: { fontSize: 14, color: '#f8fafc', fontWeight: '500' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#f8fafc', marginBottom: 10 },
  bodyText: { fontSize: 14, color: '#cbd5e1', lineHeight: 22 },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 60, fontSize: 14 },
});
