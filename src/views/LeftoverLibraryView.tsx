import { useMemo, useState } from 'react';
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
  IconButton,
  Input,
  NumberInput,
  NumberInputField,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Stat,
  StatLabel,
  StatNumber,
  Switch,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  Tooltip,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { CheckCircle2, CloudOff, CloudRain, RefreshCw, Trash2, UserPlus, XCircle } from 'lucide-react';
import { useAtomValue } from 'jotai';
import { projectAtom } from '../stores/project';
import { useLeftoverLibrary } from '../hooks/useLeftoverLibrary';
import type { ClaimResult, RegisterResult } from '../utils/leftoverLibrary';
import type { Leftover, LeftoverStatus } from '../types/woodworking';

const STATUS_LABEL: Record<LeftoverStatus, { text: string; color: string }> = {
  available: { text: '可用', color: 'green' },
  occupied: { text: '已占用', color: 'orange' },
  consumed: { text: '已用', color: 'gray' },
};

function stockName(project: ReturnType<typeof useAtomValue<typeof projectAtom>>, stockId: string) {
  return project.stocks.find((stock) => stock.id === stockId)?.name ?? stockId;
}

export function LeftoverLibraryView() {
  const project = useAtomValue(projectAtom);
  const {
    leftovers,
    state,
    isOnline,
    register,
    claim,
    release,
    remove,
    recoverById,
    flushOutbox,
    setOnline,
    armNextFailure,
  } = useLeftoverLibrary();
  const toast = useToast();

  const [form, setForm] = useState({ id: '', length: 600, width: 400, thickness: 18, stockId: project.stocks[0]?.id ?? '' });
  const [claimer, setClaimer] = useState('师傅A');
  const [claimTarget, setClaimTarget] = useState<string | null>(null);
  const [claimLog, setClaimLog] = useState<Array<{ id: string; who: string; result: ClaimResult }>>([]);
  const stats = useMemo(() => {
    const available = leftovers.filter((item) => item.status === 'available').length;
    const occupied = leftovers.filter((item) => item.status === 'occupied').length;
    const consumed = leftovers.filter((item) => item.status === 'consumed').length;
    return { available, occupied, consumed };
  }, [leftovers]);

  const notifyRegister = (result: RegisterResult, leftoverId: string) => {
    if (result.status === 'stored') {
      toast({ title: '余料已入库', description: `编号 ${result.leftover?.id ?? leftoverId}`, status: 'success' });
    } else if (result.status === 'duplicate') {
      toast({ title: '编号已存在，未重复入库', description: `编号 ${result.leftover?.id ?? leftoverId} 只保留一条`, status: 'info' });
    } else if (result.status === 'queued-capacity') {
      toast({ title: '库容已满，已排队等位', description: '有空位后自动入库', status: 'warning' });
    } else if (result.status === 'queued-offline') {
      toast({ title: '已断网，记录进入待重传', description: '回网后按编号合并入库', status: 'warning' });
    } else if (result.status === 'failed') {
      toast({ title: '写入失败，已按编号留待恢复', description: result.error, status: 'error' });
    }
  };

  const submitRegister = async (mode: 'online' | 'offline' | 'fail') => {
    if (!form.stockId) {
      toast({ title: '请选择所属板材', status: 'warning' });
      return;
    }
    if (mode === 'offline') setOnline(false);
    if (mode === 'fail') armNextFailure();
    const result = await register({
      id: form.id.trim() || undefined,
      length: Number(form.length) || 0,
      width: Number(form.width) || 0,
      thickness: Number(form.thickness) || 0,
      stockId: form.stockId,
      source: 'manual',
    });
    notifyRegister(result, form.id);
    if (mode === 'offline') setOnline(true);
  };

  const runClaim = (id: string, who: string) => {
    const result = claim(id, who);
    setClaimLog((log) => [{ id, who, result }, ...log].slice(0, 8));
    return result;
  };

  const simultaneousClaim = () => {
    const target = leftovers.find((item) => item.status === 'available')?.id;
    if (!target) {
      toast({ title: '没有可占用的余料', description: '请先登记一块可用余料', status: 'warning' });
      return;
    }
    // 同一 tick 内先后提交：先到先得，只留先到的。
    const first = runClaim(target, '师傅A');
    const second = runClaim(target, '师傅B');
    if (second.status === 'occupied') {
      toast({
        title: '师傅B 未抢到，占用者是师傅A',
        description: `编号 ${target} 已被占用，师傅B 请换料`,
        status: 'warning',
      });
    }
    void first;
  };

  const switchMaterial = (forWho: string) => {
    const alternative = leftovers.find((item) => item.status === 'available');
    if (!alternative) {
      toast({ title: '暂无可用余料可换', status: 'warning' });
      return;
    }
    const result = runClaim(alternative.id, forWho);
    toast({
      title: `${forWho} 已换料`,
      description: `改占 ${alternative.id}（${result.status === 'ok' ? '占用成功' : result.status}）`,
      status: 'success',
    });
  };

  return (
    <main className="page-shell">
      <Flex justify="space-between" align="end" mb="14px" gap="12px" wrap="wrap">
        <Box>
          <Text className="eyebrow">STEP 04 · 余料库</Text>
          <Text className="page-title">余料库与开料账</Text>
          <Text className="page-desc">
            余料写明编号、长宽厚与所属板材，排料时能放下就先用余料。断网登记回网后按编号合并，
            晚到的记录不会盖掉先登记的；写入失败可按编号恢复，重传只入库一次。
          </Text>
        </Box>
        <HStack>
          <HStack px="10px" py="6px" borderWidth="1px" borderColor="slate.200" borderRadius="8px" bg="white">
            {isOnline ? <CloudRain size={15} color="#2f855a" /> : <CloudOff size={15} color="#c05621" />}
            <Text fontSize="11px" fontWeight="700">{isOnline ? '联网' : '断网'}</Text>
            <Switch isChecked={isOnline} onChange={(event) => setOnline(event.target.checked)} colorScheme="teal" />
          </HStack>
          <Button colorScheme="teal" variant="outline" leftIcon={<RefreshCw size={15} />} onClick={flushOutbox} isDisabled={!isOnline || state.outbox.length === 0}>
            回网重传 ({state.outbox.length})
          </Button>
        </HStack>
      </Flex>

      <SimpleGrid columns={{ base: 2, md: 4 }} spacing="10px" mb="14px">
        <StatBox label="可用余料" value={stats.available} accent="green" />
        <StatBox label="已占用" value={stats.occupied} accent="orange" />
        <StatBox label="已用余料" value={stats.consumed} accent="gray" />
        <StatBox label="库容 / 等位" value={`${state.activeCount}/${state.capacity}`} accent="teal" hint={`${state.waitQueue.length} 组等位`} />
      </SimpleGrid>

      <Grid templateColumns={{ base: '1fr', xl: 'minmax(0, 1fr) 340px' }} gap="14px" alignItems="start">
        <Stack spacing="14px">
          <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" p="14px">
            <Flex justify="space-between" align="center" mb="10px">
              <Text fontSize="12px" fontWeight="800">余料台账</Text>
              <Text fontSize="10px" color="slate.500">共 {leftovers.length} 条 · 版本随占用递增</Text>
            </Flex>
            <Progress size="xs" colorScheme="teal" value={(state.activeCount / state.capacity) * 100} borderRadius="full" mb="10px" />
            <TableContainer maxH="460px" overflowY="auto">
              <Table size="sm">
                <Thead position="sticky" top="0" bg="slate.100" zIndex="1">
                  <Tr>
                    <Th>编号</Th>
                    <Th>长×宽×厚 (mm)</Th>
                    <Th>所属板材</Th>
                    <Th>状态</Th>
                    <Th>版本</Th>
                    <Th>占用者</Th>
                    <Th />
                  </Tr>
                </Thead>
                <Tbody>
                  {leftovers.map((item) => {
                    const meta = STATUS_LABEL[item.status];
                    return (
                      <Tr key={item.id} cursor="pointer" onClick={() => setClaimTarget(item.id)} _hover={{ bg: 'teal.50' }} bg={claimTarget === item.id ? 'teal.50' : undefined}>
                        <Td><Text fontSize="11px" fontWeight="750">{item.id}</Text>{item.source === 'nesting' && <Badge ml="4px" fontSize="8px" colorScheme="purple">排料</Badge>}</Td>
                        <Td fontSize="10px">{item.length}×{item.width}×{item.thickness}</Td>
                        <Td fontSize="10px">{stockName(project, item.stockId)}</Td>
                        <Td><Badge colorScheme={meta.color} fontSize="9px">{meta.text}</Badge></Td>
                        <Td fontSize="10px">v{item.version}</Td>
                        <Td fontSize="10px">{item.occupiedBy ?? '—'}</Td>
                        <Td isNumeric>
                          <HStack spacing="4px" justify="flex-end" onClick={(event) => event.stopPropagation()}>
                            {item.status === 'available' && (
                              <Tooltip label="占用（先到先得）">
                                <IconButton aria-label="占用" size="xs" variant="outline" colorScheme="orange" icon={<UserPlus size={12} />} onClick={() => runClaim(item.id, claimer)} />
                              </Tooltip>
                            )}
                            {item.status === 'occupied' && (
                              <Tooltip label="释放占用">
                                <IconButton aria-label="释放" size="xs" variant="outline" icon={<RefreshCw size={12} />} onClick={() => release(item.id)} />
                              </Tooltip>
                            )}
                            <Tooltip label="作废并腾出库容">
                              <IconButton aria-label="删除" size="xs" variant="ghost" colorScheme="red" icon={<Trash2 size={12} />} onClick={() => remove(item.id)} />
                            </Tooltip>
                          </HStack>
                        </Td>
                      </Tr>
                    );
                  })}
                  {leftovers.length === 0 && (
                    <Tr><Td colSpan={7}><Text fontSize="11px" color="slate.500" textAlign="center" py="18px">余料库为空，登记一条余料开始</Text></Td></Tr>
                  )}
                </Tbody>
              </Table>
            </TableContainer>
          </Box>

          {state.waitQueue.length > 0 && (
            <Box borderWidth="1px" borderColor="amber.200" borderRadius="10px" bg="amber.50" p="14px">
              <Text fontSize="12px" fontWeight="800" color="amber.800">等位队列（{state.waitQueue.length}）</Text>
              <Stack mt="8px" spacing="4px">
                {state.waitQueue.map((waiter) => (
                  <Text key={waiter.id} fontSize="10px" color="amber.800">· {waiter.name}（库容 {state.activeCount}/{state.capacity}，有空位自动入库）</Text>
                ))}
              </Stack>
            </Box>
          )}

          {state.outbox.length > 0 && (
            <Box borderWidth="1px" borderColor="red.200" borderRadius="10px" bg="red.50" p="14px">
              <Flex justify="space-between" align="center">
                <Text fontSize="12px" fontWeight="800" color="red.800">待重传 / 待恢复（{state.outbox.length}）</Text>
                <Button size="xs" colorScheme="red" variant="outline" onClick={flushOutbox} isDisabled={!isOnline}>全部重传</Button>
              </Flex>
              <Stack mt="8px" spacing="4px">
                {state.outbox.map((item) => (
                  <Flex key={item.id} justify="space-between" align="center" fontSize="10px" color="red.800">
                    <Text>· {item.name} — {item.reason}</Text>
                    <Button size="xs" variant="ghost" colorScheme="red" onClick={() => recoverById(item.id)} isDisabled={!isOnline}>按编号恢复</Button>
                  </Flex>
                ))}
              </Stack>
            </Box>
          )}
        </Stack>

        <Stack spacing="14px">
          <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" p="14px">
            <Text fontSize="12px" fontWeight="800" mb="10px">登记余料</Text>
            <VStack spacing="9px" align="stretch">
              <FormControl>
                <FormLabel fontSize="10px">编号（留空自动生成）</FormLabel>
                <Input size="sm" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder="如 leftover-walnut-01" />
              </FormControl>
              <Grid templateColumns="1fr 1fr 1fr" gap="8px">
                <FormControl>
                  <FormLabel fontSize="10px">长 (mm)</FormLabel>
                  <NumberInput size="sm" min={1} value={form.length} onChange={(_, value) => setForm({ ...form, length: value || 0 })}>
                    <NumberInputField />
                  </NumberInput>
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="10px">宽 (mm)</FormLabel>
                  <NumberInput size="sm" min={1} value={form.width} onChange={(_, value) => setForm({ ...form, width: value || 0 })}>
                    <NumberInputField />
                  </NumberInput>
                </FormControl>
                <FormControl>
                  <FormLabel fontSize="10px">厚 (mm)</FormLabel>
                  <NumberInput size="sm" min={1} value={form.thickness} onChange={(_, value) => setForm({ ...form, thickness: value || 0 })}>
                    <NumberInputField />
                  </NumberInput>
                </FormControl>
              </Grid>
              <FormControl>
                <FormLabel fontSize="10px">所属板材</FormLabel>
                <Select size="sm" value={form.stockId} onChange={(event) => setForm({ ...form, stockId: event.target.value })}>
                  {project.stocks.map((stock) => (
                    <option key={stock.id} value={stock.id}>{stock.name} · {stock.length}×{stock.width}×{stock.thickness}</option>
                  ))}
                </Select>
              </FormControl>
              <Button size="sm" colorScheme="teal" onClick={() => submitRegister('online')}>登记入库</Button>
              <HStack>
                <Button size="xs" variant="outline" leftIcon={<CloudOff size={12} />} onClick={() => submitRegister('offline')} flex="1">断网登记</Button>
                <Button size="xs" variant="outline" colorScheme="red" leftIcon={<XCircle size={12} />} onClick={() => submitRegister('fail')} flex="1">模拟失败</Button>
              </HStack>
            </VStack>
          </Box>

          <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" p="14px">
            <Text fontSize="12px" fontWeight="800" mb="10px">并发占用演示</Text>
            <Text fontSize="10px" color="slate.500" mb="8px">两人同时提交同一块余料，只留先到的；后到者看到占用者并换料。</Text>
            <FormControl mb="8px">
              <FormLabel fontSize="10px">占用者</FormLabel>
              <Input size="sm" value={claimer} onChange={(event) => setClaimer(event.target.value)} />
            </FormControl>
            <HStack mb="8px">
              <Button size="xs" variant="outline" onClick={() => claimTarget && runClaim(claimTarget, '师傅A')} flex="1">师傅A 占用</Button>
              <Button size="xs" variant="outline" onClick={() => claimTarget && runClaim(claimTarget, '师傅B')} flex="1">师傅B 占用</Button>
            </HStack>
            <Button size="sm" colorScheme="orange" onClick={simultaneousClaim} width="100%">同时提交（A 先 B 后）</Button>
            <Divider my="10px" />
            <Text fontSize="10px" fontWeight="700" mb="6px">占用结果</Text>
            <VStack align="stretch" spacing="4px">
              {claimLog.map((entry, index) => (
                <HStack key={index} fontSize="10px" justify="space-between">
                  <Text>{entry.who} → {entry.id}</Text>
                  {entry.result.status === 'ok' ? (
                    <Badge colorScheme="green" fontSize="8px"><CheckCircle2 size={9} /> 占用成功 v{entry.result.version}</Badge>
                  ) : entry.result.status === 'occupied' ? (
                    <Badge colorScheme="orange" fontSize="8px"><XCircle size={9} /> 已被 {entry.result.occupiedBy} 占用</Badge>
                  ) : (
                    <Badge colorScheme="gray" fontSize="8px">{entry.result.status}</Badge>
                  )}
                </HStack>
              ))}
              {claimLog.length === 0 && <Text fontSize="10px" color="slate.500">点击按钮查看先到先得结果</Text>}
            </VStack>
            {claimLog.some((entry) => entry.result.status === 'occupied') && (
              <Button size="xs" variant="outline" colorScheme="teal" mt="8px" onClick={() => switchMaterial('师傅B')} width="100%">师傅B 换一块余料</Button>
            )}
          </Box>

          <Box borderWidth="1px" borderColor="teal.200" borderRadius="10px" bg="teal.50" p="12px">
            <Text fontSize="11px" fontWeight="800" color="teal.800">升级说明</Text>
            <Text mt="4px" fontSize="10px" color="teal.800">
              旧数据没有余料编号，读回时自动补全编号并标记首版 v1；此后按编号合并，晚到的记录不会盖掉先登记的。
            </Text>
          </Box>
        </Stack>
      </Grid>
    </main>
  );
}

function StatBox({ label, value, accent, hint }: { label: string; value: number | string; accent: string; hint?: string }) {
  return (
    <Box borderWidth="1px" borderColor="slate.200" borderRadius="10px" bg="white" p="12px">
      <Stat>
        <StatLabel fontSize="9px" color="slate.500" textTransform="uppercase" letterSpacing=".06em" fontWeight="800">{label}</StatLabel>
        <StatNumber fontSize="22px" fontWeight="900" color={`${accent}.700`}>{value}</StatNumber>
        {hint && <Text fontSize="9px" color="slate.500">{hint}</Text>}
      </Stat>
    </Box>
  );
}
