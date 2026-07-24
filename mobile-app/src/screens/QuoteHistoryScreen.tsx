import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch } from '../services/api';

interface HistoryItem {
  id: string;
  quote_request_id: string;
  vendor_status: string;
  rfq_status: string;
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

const STATUS_CFG: Record<string, { color: string; bg: string; label: string }> = {
  quoted:   { color: '#4ade80', bg: '#14532d', label: 'Quoted' },
  accepted: { color: '#60a5fa', bg: '#1e3a5f', label: 'Accepted' },
  declined: { color: '#f87171', bg: '#450a0a', label: 'Declined' },
  passed:   { color: '#94a3b8', bg: '#1e293b', label: 'Passed' },
  expired:  { color: '#64748b', bg: '#0f172a', label: 'Expired' },
};

export default function QuoteHistoryScreen({ navigation }: any) {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function fetchHistory() {
    try {
      const res = await apiFetch('/vendor/quotes/history');
      if (res.ok) {
        const d = await res.json();
        setHistory(d.history || []);
      }
    } catch {}
    setLoading(false);
    setRefreshing(false);
  }

  useFocusEffect(useCallback(() => { fetchHistory(); }, []));

  function renderItem({ item }: { item: HistoryItem }) {
    const cfg = STATUS_CFG[item.vendor_status] || STATUS_CFG.expired;
    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('VendorChat', { job: { ...item, id: item.id, vendor_status: item.vendor_status } })}
      >
        <View style={styles.cardTop}>
          <Text style={styles.category}>{item.category_label}</Text>
          <View style={[styles.badge, { backgroundColor: cfg.bg }]}>
            <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
          </View>
        </View>
        <Text style={styles.address}>{item.address}, {item.city}, {item.state}</Text>
        {item.quoted_amount != null && (
          <Text style={styles.amount}>Your quote: ${item.quoted_amount.toFixed(2)}</Text>
        )}
        {item.quote_message ? (
          <Text style={styles.msg} numberOfLines={1}>{item.quote_message}</Text>
        ) : null}
        <Text style={styles.date}>
          {item.quoted_at
            ? `Quoted ${new Date(item.quoted_at).toLocaleDateString()}`
            : `Requested ${new Date(item.created_at).toLocaleDateString()}`}
        </Text>
      </TouchableOpacity>
    );
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#2563eb" /></View>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Quote History</Text>
        <Text style={styles.subtitle}>{history.length} past quotes</Text>
      </View>
      <FlatList
        data={history}
        keyExtractor={i => i.id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: 16, paddingTop: 4 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchHistory(); }} tintColor="#2563eb" />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📜</Text>
            <Text style={styles.emptyText}>No quote history yet</Text>
            <Text style={styles.emptySubtext}>Submitted and passed quotes will appear here</Text>
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
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  category: { fontSize: 15, fontWeight: '700', color: '#f8fafc', flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  address: { fontSize: 13, color: '#94a3b8', marginBottom: 4 },
  amount: { fontSize: 14, fontWeight: '700', color: '#4ade80', marginBottom: 2 },
  msg: { fontSize: 12, color: '#64748b', marginBottom: 4 },
  date: { fontSize: 11, color: '#475569' },
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 16, fontWeight: '600', color: '#f8fafc', marginBottom: 4 },
  emptySubtext: { fontSize: 13, color: '#64748b', textAlign: 'center' },
});
