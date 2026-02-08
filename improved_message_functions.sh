get_message_count_from_jid() {
  local jid="$1"
  local searchText="${2:-}"
  local dataDir="${OPENCLAW_DATA:-./data}"
  local safeJid=$(echo "$jid" | sed 's/[^a-zA-Z0-9@._-]/_/g')
  local msgFile="$dataDir/messages/direct/${safeJid}.json"
  
  if [ -f "$msgFile" ]; then
    if [ -n "$searchText" ]; then
      jq -r ".messages | map(select(.from == \"$jid\" and (.body // \"\") | contains(\"$searchText\"))) | length // 0" "$msgFile"
    else
      jq -r ".messages | map(select(.from == \"$jid\")) | length // 0" "$msgFile"
    fi
  else
    echo "0"
  fi
}

has_messages_from_jid() {
  local jid="$1"
  local searchText="${2:-}"
  local count
  count=$(get_message_count_from_jid "$jid" "$searchText")
  [ "$count" -gt 0 ]
}

get_sample_messages_from_jid() {
  local jid="$1"
  local limit="${2:-3}"
  local dataDir="${OPENCLAW_DATA:-./data}"
  local safeJid=$(echo "$jid" | sed 's/[^a-zA-Z0-9@._-]/_/g')
  local msgFile="$dataDir/messages/direct/${safeJid}.json"
  
  if [ -f "$msgFile" ]; then
    jq -r ".messages | map(select(.from == \"$jid\"))[:$limit][] | \"[\(.timestamp // \"unknown\")] \(.body // \"(no body)\")\"" "$msgFile" 2>/dev/null
  fi
}
