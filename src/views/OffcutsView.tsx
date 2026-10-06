import { useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  Grid,
  HStack,
  Input,
  NumberInput,
  NumberInputField,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
} from '@chakra-ui/react';
import { CloudOff, CloudUpload, Layers, Lock, RefreshCw, RotateCcw, Unlock } from 'lucide-react';
import { useAtom, useAtomValue } from 'jotai';
import { offcutLedgerAtom, operatorAtom } from '../stores/offcuts';
import { projectAtom } from '../stores/project';
import {
  claimOffcut,
  ingestOffcuts,
  nextOffcutCode,
  registerOffcut,
  releaseOffcut,
  removeOffcut,
  suggestAlternatives,
  syncOutbox,
} from '../utils/offcuts';
import type { Offcut } from '../types/woodworking';

const OPERATORS = ['工位A', '工位B', '工位C'];

function formatTime(ts: number | null) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function OffcutsView() {
  const [ledger, setLedger] = useAtom(offcutLedgerAtom);
  const [operator, setOperator] = useAtom(operatorAtom);
  const project = useAtomValue(projectAtom);
  const toast = useToast();

  const [stockId, setStockId] = useState(project.stocks[0]?.id ?? '');
  const [length, setLength] = useState(600);
  const [width, setWidth] = useState(400);
  const [note, setNote] = useState('');
  const [conflict, setConflict] = useState<{ offcut: Offcut; alternatives: Offcut[] } | null>(null);
  const [lastBatch, setLastBatch] = useState<Offcut[] | null>(null);

  const stock = project.stocks.find((item) => item.id === stockId) ?? project.stocks[0];
  const occupiedCount = ledger.records.filter((offcut) => offcut.status === 'occupied').length;

  const register = () => {
    if (!stock) return;
    const offcut: Offcut = {
      code: nextOffcutCode(ledger),
      stockId: stock.id,
      length,
      width,
      thickness: stock.thickness,
      registeredBy: operator,
      registeredAt: Date.now(),
      status: 'available',
      occupiedBy: null,
      occupiedAt: null,
      note,
    };
    const result = registerOffcut(ledger, offcut);
    setLedger(result.ledger);
    setNote('');
    if (result.queuedOffline) {
      toast({ title: `${offcut.code} 已暂存本机`, description: '当前断网，回网后点“回网同步”按编号合并入库。', status: 'info' });
    } else if (result.ledger.records.some((item) => item.code === offcut.code)) {
      toast({ title: `${offcut.code} 已入库`, status: 'success' });
    } else {
      toast({ title: `余料库已满`, description: `${offcut.code} 进入排队等位，有库位空出后自动补入。`, status: 'warning' });
    }
  };

  const sync = () => {
    const batch = ledger.outbox;
    const result = syncOutbox(ledger);
    setLedger(result.ledger);
    setLastBatch(batch);
    toast({
      title: '同步完成',
      description: `入库 ${result.stored} 条 · 排队等位 ${result.queued} 条 · 按编号去重 ${result.duplicates} 条`,
      status: 'success',
    });
  };

  const retransmit = () => {
    if (!lastBatch || lastBatch.length === 0) return;
    const result = ingestOffcuts(ledger, lastBatch);
    setLedger(result.ledger);
    toast({
      title: '重传完成',
      description: `重传 ${lastBatch.length} 条，实际入库 ${result.stored} 条 · 按编号去重 ${result.duplicates} 条，同一编号只入库一次。`,
      status: result.stored === 0 ? 'info' : 'success',
    });
  };

  const claim = (code: string) => {
    const result = claimOffcut(ledger, code, operator);
    setLedger(result.ledger);
    if (result.conflict) {
      setConflict({ offcut: result.conflict, alternatives: suggestAlternatives(ledger, result.conflict) });
    } else {
      setConflict(null);
      toast({ title: `${code} 已由 ${operator} 占用`, status: 'success' });
    }
  };

  return (
    <main className="page-shell">
      <Flex justify="space-between" align="end" mb="14px" gap="12px" wrap="wrap">
        <Box>
          <Text className="eyebrow">STEP 02 · 余料台账</Text>
          <Text className="page-title">余料库登记与占用</Text>
          <Text className="page-desc">
            各工位断网也能登记，回网后按编号合并，同一编号只留先登记的一条；排料时优先用余料，放不下再开新板。
          </Text>
        </Box>
        <HStack spacing="10px">
          <FormControl display="flex" alignItems="center" w="auto">
            <FormLabel mb="0" fontSize="11px" color="slate.600">当前工位</FormLabel>
            <Select size="sm" w="104px" bg="white" value={operator} onChange={(event) => setOperator(event.target.value)}>
              {OPERATORS.map((name) => <option key={name}>{name}</option>)}
            </Select>
          </FormControl>
          <FormControl display="flex" alignItems="center" w="auto">
            <FormLabel mb="0" fontSize="11px" color="slate.600">{ledger.online ? '在线' : '断网'}</FormLabel>
            <Switch isChecked={ledger.online} onChange={(event) => setLedger((current) => ({ ...current, online: event.target.checked }))} />
          </FormControl>
        </HStack>
      </Flex>

      <SimpleGrid columns={{ base: 2, lg: 4 }} spacing="10px" mb="14px">
        <Metric label="在库余料" value={`${ledger.records.length} / ${ledger.capacity}`} accent="teal" />
        <Metric label="排队等位" value={`${ledger.pending.length} 块`} accent={ledger.pending.length ? 'orange' : 'gray'} />
        <Metric label="待同步" value={`${ledger.outbox.length} 条`} accent={ledger.outbox.length ? 'purple' : 'gray'} />
        <Metric label="已被占用" value={`${occupiedCount} 块`} accent={occupiedCount ? 'blue' : 'gray'} />
      </SimpleGrid>

      <Grid templateColumns={{ base: '1fr', xl: '330px minmax(0, 1fr)' }} gap="14px" alignItems="start">
        <Stack spacing="12px">
          <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" p="14px">
            <Text fontSize="12px" fontWeight="800" mb="10px">登记余料</Text>
            <Stack spacing="10px">
              <FormControl>
                <FormLabel fontSize="10px">所属板材</FormLabel>
                <Select size="sm" value={stockId} onChange={(event) => setStockId(event.target.value)}>
                  {project.stocks.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} · 厚 {item.thickness} mm</option>
                  ))}
                </Select>
              </FormControl>
              <Grid templateColumns="1fr 1fr" gap="10px">
                <FormControl>
                  <FormLabel fontSize="10px">长 (mm)</FormLabel>
                  <NumberInput size="sm" min={50} value={length} onChange={(_, value) => setLength(Number.isFinite(value) ? value : 50)}>
                    <NumberInputField />
                  </NumberInput>
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="10px">宽 (mm)</FormLabel>
                  <NumberInput size="sm" min={50} value={width} onChange={(_, value) => setWidth(Number.isFinite(value) ? value : 50)}>
                    <NumberInputField />
                  </NumberInput>
                </FormControl>
              </Grid>
              <FormControl>
                <FormLabel fontSize="10px">备注</FormLabel>
                <Input size="sm" value={note} placeholder="例如：顶板裁剩" onChange={(event) => setNote(event.target.value)} />
              </FormControl>
              <Button size="sm" colorScheme="teal" leftIcon={<Layers size={14} />} onClick={register} isDisabled={!stock}>
                {ledger.online ? '登记入库' : '断网暂存本机'}
              </Button>
              <Text fontSize="10px" color="slate.500">
                编号自动分配（下一块 {nextOffcutCode(ledger)}），厚度跟随所属板材 {stock?.thickness ?? '—'} mm。
              </Text>
            </Stack>
          </Box>

          <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" p="14px">
            <Flex justify="space-between" align="center" mb="10px">
              <Text fontSize="12px" fontWeight="800">同步与库位</Text>
              <Badge colorScheme={ledger.online ? 'green' : 'orange'}>{ledger.online ? '在线' : '断网'}</Badge>
            </Flex>
            <Progress size="xs" colorScheme={ledger.records.length >= ledger.capacity ? 'orange' : 'teal'} value={(ledger.records.length / ledger.capacity) * 100} borderRadius="full" />
            <Text mt="6px" fontSize="10px" color="slate.500">
              库位 {ledger.records.length}/{ledger.capacity} · 上次同步 {formatTime(ledger.lastSyncAt)} · 台账版本 v{ledger.schemaVersion}
            </Text>
            <Divider my="10px" />
            <Stack spacing="8px">
              <Button size="sm" colorScheme="teal" variant="outline" leftIcon={<CloudUpload size={14} />} onClick={sync} isDisabled={ledger.outbox.length === 0 || !ledger.online}>
                回网同步（{ledger.outbox.length} 条待合并）
              </Button>
              <Button size="sm" variant="ghost" leftIcon={<RotateCcw size={14} />} onClick={retransmit} isDisabled={!lastBatch || lastBatch.length === 0}>
                重传上一批（验证只入库一次）
              </Button>
              {!ledger.online && (
                <HStack color="orange.600"><CloudOff size={14} /><Text fontSize="10px">断网中，登记会先存在本机。</Text></HStack>
              )}
            </Stack>
            {ledger.pending.length > 0 && (
              <Box mt="10px" p="9px" bg="orange.50" borderRadius="8px" borderWidth="1px" borderColor="orange.200">
                <Text fontSize="10px" fontWeight="800" color="orange.800">排队等位</Text>
                {ledger.pending.map((offcut) => (
                  <Text key={offcut.code} fontSize="10px" color="orange.800" mt="3px">
                    {offcut.code} · {offcut.length}×{offcut.width} · {offcut.registeredBy}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        </Stack>

        <Stack spacing="12px">
          {conflict && (
            <Box borderWidth="1px" borderColor="red.200" borderRadius="10px" bg="red.50" p="14px">
              <HStack color="red.700"><Lock size={15} /><Text fontSize="12px" fontWeight="800">占用冲突</Text></HStack>
              <Text mt="6px" fontSize="11px" color="red.700">
                余料 {conflict.offcut.code} 已被 {conflict.offcut.occupiedBy} 于 {formatTime(conflict.offcut.occupiedAt)} 占用，先到先得，请换一块料。
              </Text>
              {conflict.alternatives.length > 0 ? (
                <HStack mt="9px" wrap="wrap" spacing="8px">
                  <Text fontSize="10px" color="red.700">可换：</Text>
                  {conflict.alternatives.map((alt) => (
                    <Button key={alt.code} size="xs" colorScheme="teal" variant="outline" bg="white" onClick={() => claim(alt.code)}>
                      改用 {alt.code}（{alt.length}×{alt.width}）
                    </Button>
                  ))}
                </HStack>
              ) : (
                <Text mt="8px" fontSize="10px" color="red.600">同板材暂无更大余料，排料时会自动开新板。</Text>
              )}
              <Button mt="9px" size="xs" variant="ghost" onClick={() => setConflict(null)}>知道了</Button>
            </Box>
          )}

          <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" overflow="hidden">
            <Flex p="13px" justify="space-between" align="center" borderBottomWidth="1px">
              <Box>
                <Text fontSize="12px" fontWeight="800">余料台账</Text>
                <Text fontSize="10px" color="slate.500">按编号合并 · 先到先得 · 重传去重</Text>
              </Box>
              <Badge variant="outline">v{ledger.schemaVersion}</Badge>
            </Flex>
            <TableContainer maxH="560px" overflowY="auto">
              <Table size="sm">
                <Thead position="sticky" top="0" bg="slate.100" zIndex="1">
                  <Tr>
                    <Th>编号</Th>
                    <Th>所属板材</Th>
                    <Th>长×宽×厚</Th>
                    <Th>状态</Th>
                    <Th>登记</Th>
                    <Th>操作</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {ledger.records.map((offcut) => {
                    const offcutStock = project.stocks.find((item) => item.id === offcut.stockId);
                    return (
                      <Tr key={offcut.code}>
                        <Td><Text fontSize="11px" fontWeight="800">{offcut.code}</Text>{offcut.note && <Text fontSize="9px" color="slate.500">{offcut.note}</Text>}</Td>
                        <Td><Text fontSize="10px">{offcutStock?.name ?? offcut.stockId}</Text><Text fontSize="9px" color="slate.500">{offcutStock?.material}</Text></Td>
                        <Td fontSize="10px">{offcut.length} × {offcut.width} × {offcut.thickness}</Td>
                        <Td>
                          {offcut.status === 'occupied' ? (
                            <Badge colorScheme="blue">占用中 · {offcut.occupiedBy}</Badge>
                          ) : (
                            <Badge colorScheme="green">可用</Badge>
                          )}
                        </Td>
                        <Td><Text fontSize="10px">{offcut.registeredBy}</Text><Text fontSize="9px" color="slate.500">{formatTime(offcut.registeredAt)}</Text></Td>
                        <Td>
                          <HStack spacing="6px">
                            {offcut.status === 'occupied' ? (
                              <Button size="xs" variant="outline" leftIcon={<Unlock size={12} />} onClick={() => setLedger(releaseOffcut(ledger, offcut.code))}>释放</Button>
                            ) : (
                              <Button size="xs" colorScheme="teal" variant="outline" leftIcon={<Lock size={12} />} onClick={() => claim(offcut.code)}>占用</Button>
                            )}
                            <Button size="xs" variant="ghost" colorScheme="red" onClick={() => setLedger(removeOffcut(ledger, offcut.code))}>用掉</Button>
                          </HStack>
                        </Td>
                      </Tr>
                    );
                  })}
                  {ledger.records.length === 0 && (
                    <Tr><Td colSpan={6}><Text py="20px" textAlign="center" fontSize="11px" color="slate.500">余料库为空，先在左侧登记。</Text></Td></Tr>
                  )}
                </Tbody>
              </Table>
            </TableContainer>
          </Box>

          {ledger.outbox.length > 0 && (
            <Box borderWidth="1px" borderColor="purple.200" borderRadius="10px" bg="purple.50" p="14px">
              <HStack color="purple.700"><RefreshCw size={14} /><Text fontSize="12px" fontWeight="800">待同步（本机暂存 {ledger.outbox.length} 条）</Text></HStack>
              {ledger.outbox.map((offcut) => (
                <Text key={offcut.code} mt="5px" fontSize="10px" color="purple.700">
                  {offcut.code} · {offcut.length}×{offcut.width}×{offcut.thickness} · {offcut.registeredBy} 登记于 {formatTime(offcut.registeredAt)}
                </Text>
              ))}
            </Box>
          )}
        </Stack>
      </Grid>
    </main>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" p="12px">
      <Text fontSize="9px" color="slate.500" textTransform="uppercase" letterSpacing=".06em" fontWeight="800">{label}</Text>
      <Text mt="5px" fontSize="20px" fontWeight="900" color={`${accent}.700`}>{value}</Text>
    </Box>
  );
}
