import { ExtensionUniqueViolation, type ExtensionInstance } from '@stackpanel/sdk';
import { context } from './context';
import { codeModel, type ReferralCode } from './data';
import { ReferralPluginError } from './errors';

/**
 * 单用户可持有的推广码上限。
 *
 * 不是配置项：真正需要放宽时应该走配置模型，而不是让每个用户无限制地建码刷满
 * 索引表。数量本身很小，硬上限足够。
 */
const MAX_CODES_PER_USER = 20;

/** 生成短码时排除易混淆字符（0/O、1/I/L），降低人工转述出错率。 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 9;

/** 随机短码：不暴露 userId，也不可枚举猜测。 */
export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) {
    code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
  }
  return code;
}

export interface CreateCodeInput {
  label?: string;
  rewardAmount?: number | null;
}

/** 读出一个用户自己的全部推广码（含已停用的，方便他们自己看历史）。 */
export async function listCodes(ownerId: string): Promise<Array<ExtensionInstance<ReferralCode>>> {
  const { items } = await context().extensions.list<ReferralCode>(codeModel, {
    where: { ownerId: { eq: ownerId } },
    orderBy: { field: 'createdAt', desc: true },
    page: 1,
    pageSize: 200,
  });
  return items;
}

/**
 * 按短码查码，并要求它仍可用。
 *
 * 停用的码不再归因（`state !== 'active'` 直接拒绝），所以这里返回 null 而不是
 * 抛出，交给调用方决定是静默跳过还是报错。
 */
export async function findActiveCode(code: string): Promise<ExtensionInstance<ReferralCode> | null> {
  const { items } = await context().extensions.list<ReferralCode>(codeModel, {
    where: { code: { eq: code }, state: { eq: 'active' } },
    page: 1,
    pageSize: 1,
  });
  return items[0] ?? null;
}

/** 新建推广码；短码冲突时重试（唯一索引是最终保证，不是本地检查）。 */
export async function createCode(
  ownerId: string,
  input: CreateCodeInput,
): Promise<ExtensionInstance<ReferralCode>> {
  const extensions = context().extensions;
  const existing = await listCodes(ownerId);
  if (existing.length >= MAX_CODES_PER_USER) {
    throw new ReferralPluginError(409, '推广码数量已达上限');
  }

  const label = (input.label ?? '').trim().slice(0, 40);
  const rewardAmount = input.rewardAmount ?? null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const spec: ReferralCode = {
      ownerId,
      code: generateCode(),
      label,
      state: 'active',
      rewardAmount,
      signupCount: 0,
    };
    try {
      return await extensions.create<ReferralCode>(codeModel, spec, { ownerId });
    } catch (error) {
      if (error instanceof ExtensionUniqueViolation) continue;
      throw error;
    }
  }
  throw new ReferralPluginError(500, '无效的参数');
}

export interface UpdateCodeInput {
  label?: string;
  state?: 'active' | 'disabled';
  rewardAmount?: number | null;
}

/** 改备注 / 停用 / 改单码奖励；只能改自己的码。 */
export async function updateCode(
  ownerId: string,
  name: string,
  input: UpdateCodeInput,
): Promise<ExtensionInstance<ReferralCode>> {
  const extensions = context().extensions;
  const existing = await extensions.get<ReferralCode>(codeModel, name);
  if (!existing || existing.spec.ownerId !== ownerId) {
    throw new ReferralPluginError(404, '推广码不存在或已停用');
  }
  const spec: ReferralCode = {
    ...existing.spec,
    ...(input.label === undefined ? {} : { label: input.label.trim().slice(0, 40) }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.rewardAmount === undefined ? {} : { rewardAmount: input.rewardAmount }),
  };
  return extensions.update<ReferralCode>(codeModel, name, spec, {
    expectedVersion: existing.version,
  });
}

/** 成功归因后，对该渠道计数 +1（原子自增，不读改写）。 */
export async function bumpSignupCount(name: string): Promise<void> {
  try {
    await context().extensions.updateWhere(codeModel, { name: { eq: name } }, {
      signupCount: { inc: 1 },
    });
  } catch (error) {
    // 计数只是展示用，不能因为一次计数失败把已经成立的归因回滚掉。
    context().logger.warn(`referral: 推广码计数失败 ${name} ${String(error)}`);
  }
}
