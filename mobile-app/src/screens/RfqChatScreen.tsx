import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { apiFetch, getStoredUser } from '../services/api';

interface Message {
  message_id: string;
  sender_type: 'vendor' | 'admin' | 'system';
  sender_name: string;
  body: string;
  created_at: string;
}

export default function RfqChatScreen({ route, navigation }: any) {
  const { job } = route.params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [amount, setAmount] = useState('');
  const [quoteMsg, setQuoteMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const flatRef = useRef<FlatList>(null);

  const alreadyQuoted = job.vendor_status === 'quoted';
  const passed = job.vendor_status === 'passed';

  useEffect(() => {
    getStoredUser().then(u => setCurrentUser(u));
  }, []);

  async function loadMessages() {
    try {
      const res = await apiFetch(`/vendor/quote-requests/${job.quote_request_id || job.id}/messages`);
      if (res.ok) {
        const d = await res.json();
        setMessages(d.messages || []);
        setTimeout(() => flatRef.current?.scrollToEnd({ animated: false }), 100);
      }
    } catch {}
  }

  useFocusEffect(useCallback(() => {
    loadMessages();
    const interval = setInterval(loadMessages, 15000);
    return () => clearInterval(interval);
  }, []));

  async function sendMessage() {
    if (!input.trim()) return;
    setSending(true);
    try {
      const res = await apiFetch(`/vendor/quote-requests/${job.quote_request_id || job.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: input.trim() }),
      });
      if (res.ok) {
        setInput('');
        await loadMessages();
      }
    } catch {}
    setSending(false);
  }

  async function submitQuote() {
    if (!amount.trim() || !quoteMsg.trim()) {
      Alert.alert('Required', 'Enter both a price and a message.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch(`/vendor/quote-requests/${job.id}/quote`, {
        method: 'POST',
        body: JSON.stringify({ amount: parseFloat(amount), message: quoteMsg.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      Alert.alert('Quote Submitted', 'Your quote has been sent.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
    setSubmitting(false);
  }

  async function passJob() {
    Alert.alert('Pass on this job?', 'This will let Vendora know you\'re not available for this request.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Pass', style: 'destructive', onPress: async () => {
          try {
            await apiFetch(`/vendor/quote-requests/${job.quote_request_id || job.id}/pass`, { method: 'POST' });
            navigation.goBack();
          } catch {
            Alert.alert('Error', 'Failed to pass on job.');
          }
        },
      },
    ]);
  }

  function renderMessage({ item }: { item: Message }) {
    const isOwn = item.sender_type === 'vendor';
    const isSystem = item.sender_type === 'system';
    if (isSystem) {
      return (
        <View style={styles.systemMsg}>
          <Text style={styles.systemText}>{item.body}</Text>
        </View>
      );
    }
    return (
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
        {!isOwn && <Text style={styles.senderName}>{item.sender_name}</Text>}
        <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>{item.body}</Text>
        <Text style={[styles.bubbleTime, isOwn && styles.bubbleTimeOwn]}>
          {new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}>
      {/* Job summary header */}
      <View style={styles.jobHeader}>
        <Text style={styles.jobCategory}>{job.category_label}</Text>
        <Text style={styles.jobAddress}>{job.address}, {job.city}, {job.state}</Text>
        <View style={styles.jobMeta}>
          {job.property_type ? <Text style={styles.metaChip}>🏠 {job.property_type}</Text> : null}
          {job.urgency ? <Text style={styles.metaChip}>⚡ {job.urgency}</Text> : null}
          {alreadyQuoted && job.quoted_amount ? <Text style={[styles.metaChip, styles.quotedChip]}>✅ Quoted ${job.quoted_amount}</Text> : null}
          {passed ? <Text style={[styles.metaChip, styles.passedChip]}>⛔ Passed</Text> : null}
        </View>
        {job.description ? <Text style={styles.jobDesc} numberOfLines={2}>{job.description}</Text> : null}
      </View>

      {/* Chat messages */}
      <FlatList
        ref={flatRef}
        data={messages}
        keyExtractor={m => m.message_id}
        renderItem={renderMessage}
        contentContainerStyle={styles.chatList}
        ListEmptyComponent={
          <View style={styles.emptyChat}>
            <Text style={styles.emptyChatText}>No messages yet. Start the conversation below.</Text>
          </View>
        }
        onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: true })}
      />

      {/* Actions */}
      {!passed && (
        <View style={styles.actions}>
          {/* Message input always shown */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.msgInput}
              value={input}
              onChangeText={setInput}
              placeholder="Ask a question..."
              placeholderTextColor="#475569"
              multiline
              maxLength={1000}
            />
            <TouchableOpacity style={styles.sendBtn} onPress={sendMessage} disabled={sending || !input.trim()}>
              {sending ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.sendIcon}>➤</Text>}
            </TouchableOpacity>
          </View>

          {/* Quote form or toggle */}
          {!alreadyQuoted && (
            <>
              {showQuoteForm ? (
                <View style={styles.quoteForm}>
                  <TextInput style={styles.quoteInput} value={amount} onChangeText={setAmount}
                    placeholder="Price ($)" placeholderTextColor="#475569" keyboardType="decimal-pad" />
                  <TextInput style={[styles.quoteInput, styles.quoteTextarea]} value={quoteMsg} onChangeText={setQuoteMsg}
                    placeholder="Quote message / notes..." placeholderTextColor="#475569"
                    multiline numberOfLines={3} textAlignVertical="top" />
                  <View style={styles.quoteButtons}>
                    <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowQuoteForm(false)}>
                      <Text style={styles.cancelBtnText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                      onPress={submitQuote} disabled={submitting}>
                      {submitting ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.submitBtnText}>Send Quote</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View style={styles.bottomBtns}>
                  <TouchableOpacity style={styles.quoteToggleBtn} onPress={() => setShowQuoteForm(true)}>
                    <Text style={styles.quoteToggleBtnText}>💰 Submit Quote</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.passBtn} onPress={passJob}>
                    <Text style={styles.passBtnText}>Pass</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}

          {alreadyQuoted && (
            <View style={styles.quotedBanner}>
              <Text style={styles.quotedBannerText}>
                ✅ Quote submitted: ${job.quoted_amount} · {job.quote_message}
              </Text>
            </View>
          )}
        </View>
      )}

      {passed && (
        <View style={styles.passedBanner}>
          <Text style={styles.passedBannerText}>You passed on this job</Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  jobHeader: { backgroundColor: '#1e293b', padding: 14, borderBottomWidth: 1, borderBottomColor: '#334155' },
  jobCategory: { fontSize: 16, fontWeight: '800', color: '#f8fafc', marginBottom: 2 },
  jobAddress: { fontSize: 12, color: '#94a3b8', marginBottom: 6 },
  jobMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  metaChip: { fontSize: 11, backgroundColor: '#0f172a', color: '#64748b', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  quotedChip: { color: '#4ade80', backgroundColor: '#14532d' },
  passedChip: { color: '#f87171', backgroundColor: '#450a0a' },
  jobDesc: { fontSize: 12, color: '#64748b', marginTop: 2 },
  chatList: { padding: 12, paddingBottom: 4 },
  emptyChat: { paddingVertical: 40, alignItems: 'center' },
  emptyChatText: { color: '#475569', fontSize: 13, textAlign: 'center' },
  bubble: { maxWidth: '80%', marginBottom: 8, padding: 10, borderRadius: 12 },
  bubbleOwn: { alignSelf: 'flex-end', backgroundColor: '#2563eb' },
  bubbleOther: { alignSelf: 'flex-start', backgroundColor: '#1e293b' },
  senderName: { fontSize: 10, color: '#64748b', marginBottom: 3, fontWeight: '600' },
  bubbleText: { fontSize: 14, color: '#cbd5e1', lineHeight: 20 },
  bubbleTextOwn: { color: '#fff' },
  bubbleTime: { fontSize: 10, color: '#64748b', marginTop: 3, textAlign: 'right' },
  bubbleTimeOwn: { color: '#93c5fd' },
  systemMsg: { alignItems: 'center', marginVertical: 8 },
  systemText: { fontSize: 11, color: '#475569', fontStyle: 'italic' },
  actions: { borderTopWidth: 1, borderTopColor: '#334155', backgroundColor: '#1e293b', padding: 10 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 8 },
  msgInput: {
    flex: 1, backgroundColor: '#0f172a', borderWidth: 1.5, borderColor: '#334155', borderRadius: 10,
    padding: 10, fontSize: 14, color: '#f8fafc', maxHeight: 100,
  },
  sendBtn: { backgroundColor: '#2563eb', borderRadius: 10, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  sendIcon: { color: '#fff', fontSize: 16 },
  bottomBtns: { flexDirection: 'row', gap: 8 },
  quoteToggleBtn: { flex: 1, backgroundColor: '#16a34a', borderRadius: 10, padding: 12, alignItems: 'center' },
  quoteToggleBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  passBtn: { backgroundColor: '#334155', borderRadius: 10, paddingHorizontal: 20, padding: 12, alignItems: 'center' },
  passBtnText: { color: '#94a3b8', fontWeight: '600', fontSize: 14 },
  quoteForm: { gap: 8 },
  quoteInput: {
    backgroundColor: '#0f172a', borderWidth: 1.5, borderColor: '#334155', borderRadius: 8,
    padding: 11, fontSize: 14, color: '#f8fafc',
  },
  quoteTextarea: { height: 80, textAlignVertical: 'top' },
  quoteButtons: { flexDirection: 'row', gap: 8 },
  cancelBtn: { flex: 1, backgroundColor: '#334155', borderRadius: 8, padding: 12, alignItems: 'center' },
  cancelBtnText: { color: '#94a3b8', fontWeight: '600' },
  submitBtn: { flex: 2, backgroundColor: '#16a34a', borderRadius: 8, padding: 12, alignItems: 'center' },
  submitBtnText: { color: '#fff', fontWeight: '700' },
  quotedBanner: { backgroundColor: '#14532d', borderRadius: 8, padding: 10 },
  quotedBannerText: { color: '#4ade80', fontSize: 13, textAlign: 'center' },
  passedBanner: { backgroundColor: '#1e293b', padding: 14, alignItems: 'center', borderTopWidth: 1, borderTopColor: '#334155' },
  passedBannerText: { color: '#64748b', fontSize: 14 },
});
