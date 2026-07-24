import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch } from '../services/api';

interface QuoteRequestItem {
  id: string;
  quote_request_id: string;
  vendor_status: string;
  quoted_amount: number | null;
  quote_message: string | null;
  quoted_at: string | null;
  category_label: string;
  address: string;
  city: string;
  state: string;
  description: string;
  property_type: string;
  urgency: string;
  requester_name: string;
  created_at: string;
}

const STATUS_CFG: Record<string, { color: string; label: string }> = {
  quoted:        { color: '#16a34a', label: 'Quoted' },
  bid_requested: { color: '#2563eb', label: 'New Request' },
  called:        { color: '#7c3aed', label: 'Called' },
  declined:      { color: '#64748b', label: 'Declined' },
};

export default function VendorJobsScreen({ navigation }: any) {
  const [jobs, setJobs] = useState<QuoteRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function fetchJobs() {
    try {
      const res = await apiFetch('/vendor/quote-requests');
      if (res.ok) {
        const data = await res.json();
        setJobs(data.quote_requests || []);
      }
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }

  useFocusEffect(useCallback(() => { fetchJobs(); }, []));

  function renderItem({ item }: { item: QuoteRequestItem }) {
    const cfg = STATUS_CFG[item.vendor_status] || { color: '#64748b', label: item.vendor_status };
    const isNew = item.vendor_status === 'bid_requested' || item.vendor_status === 'called';
    return (
      <TouchableOpacity
        style={[styles.card, isNew && styles.cardHighlight]}
        onPress={() => navigation.navigate('VendorChat', { job: item })}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.category}>{item.category_label}</Text>
          <View style={[styles.badge, { backgroundColor: cfg.color + '22' }]}>
            <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
        </View>
        <Text style={styles.address}>{item.address}, {item.city}, {item.state}</Text>
        {item.description ? (
          <Text style={styles.desc} numberOfLines={2}>{item.description}</Text>
        ) : null}
        <View style={styles.meta}>
          <Text style={styles.metaText}>🏠 {item.property_type || 'Property'}</Text>
          {item.urgency ? <Text style={styles.metaText}>⚡ {item.urgency}</Text> : null}
          {item.quoted_amount ? <Text style={styles.metaText}>💰 ${item.quoted_amount}</Text> : null}
        </View>
        <Text style={styles.date}>{new Date(item.created_at).toLocaleDateString()}</Text>
      </TouchableOpacity>
    );
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#2563eb" /></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Job Requests</Text>
        <Text style={styles.subtitle}>{jobs.length} total · {jobs.filter(j => j.vendor_status === 'bid_requested').length} new</Text>
      </View>
      <FlatList
        data={jobs}
        keyExtractor={i => i.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingTop: 4 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchJobs(); }} tintColor="#2563eb" />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyText}>No job requests yet</Text>
            <Text style={styles.emptySubtext}>New requests will appear here</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a' },
  header: { paddingTop: 60, paddingHorizontal: 20, paddingBottom: 16 },
  title: { fontSize: 28, fontWeight: '800', color: '#f8fafc' },
  subtitle: { fontSize: 13, color: '#64748b', marginTop: 2 },
  card: { backgroundColor: '#1e293b', borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: '#334155' },
  cardHighlight: { borderColor: '#2563eb' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  category: { fontSize: 15, fontWeight: '700', color: '#f8fafc', flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  address: { fontSize: 13, color: '#94a3b8', marginBottom: 6 },
  desc: { fontSize: 13, color: '#cbd5e1', marginBottom: 8, lineHeight: 18 },
  meta: { flexDirection: 'row', gap: 12, flexWrap: 'wrap', marginBottom: 6 },
  metaText: { fontSize: 12, color: '#64748b' },
  date: { fontSize: 11, color: '#475569' },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, fontWeight: '600', color: '#f8fafc', marginBottom: 4 },
  emptySubtext: { fontSize: 13, color: '#64748b' },
});
