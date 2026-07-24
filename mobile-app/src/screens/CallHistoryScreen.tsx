import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch } from '../services/api';
import { CallRecord } from '../types';

const OUTCOME_COLORS: Record<string, string> = {
  INTERESTED_EMAIL: '#22c55e',
  INTERESTED_CALLBACK: '#3b82f6',
  NOT_INTERESTED: '#ef4444',
  VOICEMAIL: '#94a3b8',
  NO_ANSWER: '#94a3b8',
  BLOCKED: '#f97316',
  COMPLETED: '#6366f1',
  FAILED: '#ef4444',
};

export default function CallHistoryScreen({ navigation }: any) {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function loadCalls(p = 1, refresh = false) {
    if (loading && !refresh) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/admin/calls?page=${p}&limit=20`);
      const data = await res.json();
      const list = data.calls || [];
      setCalls(p === 1 ? list : [...calls, ...list]);
      setTotal(data.total || 0);
      setPage(p);
    } catch (e) {
      console.warn('Calls load failed:', e);
    }
    setLoading(false);
  }

  useFocusEffect(useCallback(() => { loadCalls(1); }, []));

  function onRefresh() {
    setRefreshing(true);
    loadCalls(1, true).then(() => setRefreshing(false));
  }

  function renderCall({ item }: { item: any }) {
    const color = OUTCOME_COLORS[item.outcome] || '#64748b';
    return (
      <TouchableOpacity
        style={styles.callCard}
        onPress={() => navigation.navigate('CallDetail', { call_id: item.call_id })}
      >
        <View style={styles.callHeader}>
          <Text style={styles.callName} numberOfLines={1}>
            {item.vendor_name || item.canonical_name || 'Unknown'}
          </Text>
          <View style={[styles.outcomeBadge, { backgroundColor: color + '20' }]}>
            <Text style={[styles.outcomeText, { color }]}>{item.outcome || '—'}</Text>
          </View>
        </View>
        <View style={styles.callMeta}>
          <Text style={styles.metaText}>
            {item.call_type === 'quote' ? '💬 Quote' : '📞 Onboarding'}
          </Text>
          <Text style={styles.metaText}>
            {new Date(item.initiated_at).toLocaleString()}
          </Text>
        </View>
        {item.summary ? (
          <Text style={styles.summary} numberOfLines={2}>{item.summary}</Text>
        ) : null}
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Call History</Text>
        <Text style={styles.count}>{total} calls</Text>
      </View>

      <FlatList
        data={calls}
        keyExtractor={(c) => c.call_id}
        renderItem={renderCall}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        onEndReached={() => {
          if (calls.length < total) loadCalls(page + 1);
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loading ? <ActivityIndicator style={{ padding: 20 }} color="#3b82f6" /> : null}
        ListEmptyComponent={
          !loading ? <Text style={styles.emptyText}>No calls yet</Text> : null
        }
        contentContainerStyle={{ paddingBottom: 20 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  header: {
    paddingTop: 60, paddingHorizontal: 20, paddingBottom: 12,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
  },
  title: { fontSize: 28, fontWeight: '800', color: '#f8fafc' },
  count: { fontSize: 14, color: '#64748b' },
  callCard: {
    backgroundColor: '#1e293b', marginHorizontal: 16, marginBottom: 8,
    borderRadius: 10, padding: 14,
  },
  callHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  callName: { fontSize: 15, fontWeight: '600', color: '#f8fafc', flex: 1, marginRight: 8 },
  outcomeBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  outcomeText: { fontSize: 11, fontWeight: '600' },
  callMeta: {
    flexDirection: 'row', justifyContent: 'space-between', marginTop: 6,
  },
  metaText: { fontSize: 12, color: '#64748b' },
  summary: { fontSize: 13, color: '#94a3b8', marginTop: 6, lineHeight: 18 },
  emptyText: { color: '#64748b', textAlign: 'center', marginTop: 40, fontSize: 14 },
});
