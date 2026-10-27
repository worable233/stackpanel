import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { FulfillmentProvider } from '@stackpanel/sdk';
import { context } from './context';
import { listAllProducts } from './repository';
import { providerForProduct } from './fulfillment';

/**
 * 履约可用性诊断。
 *
 * 为什么需要这个：商品能否履约取决于**运行期已启用的插件**，而不是商品行本身。
 * 运营者停用/卸载上游插件后，商品仍显示 `ACTIVE`，目录照常展示、加购照常成功，
 * 直到付款后才在履约任务里炸出 `provider_required` —— 钱已收、服务没有。
 *
 * 下单路径已经在 `assertSellableProduct` 拦住了这种商品，但运营者需要一个能
 * **看见问题、定位原因、当场修复**的入口，否则唯一的反馈就是「下单报错」。
 *
 * 诊断只读：不修改商品，不改状态。修复由运营者显式操作（下架或重新绑定）。
 */

/** 商品当前不可售的具体原因。 */
export type SellabilityIssueCode =
  /** 商品处于非 ACTIVE 状态（下架），本就不参与售卖。 */
  | 'INACTIVE'
  /** 云服务器商品没有绑定任何履约提供方。 */
  | 'NO_PROVIDER'
  /** 绑定的提供方插件未安装/未启用。 */
  | 'PROVIDER_MISSING'
  /** 绑定的提供方存在但不支持该商品的履约类型。 */
  | 'PROVIDER_TYPE_UNSUPPORTED'
  /** 商品类型插件缺失，无法回退到类型自带的履约实现。 */
  | 'TYPE_PROVIDER_MISSING';

export interface SellabilityIssue {
  productId: string;
  name: string;
  fulfillmentType: string;
  providerId: string | null;
  providerProductId: string | null;
  code: SellabilityIssueCode;
  /** 面向运营者的中文说明（含缺失的插件 id）。 */
  message: string;
  /** 该问题是否导致「无法交付」（INACTIVE 只是没上架，不算故障）。 */
  blocking: boolean;
}

export interface FulfillmentDiagnostics {
  issues: SellabilityIssue[];
  /** 运行期已注册的履约提供方，供后台提示「可绑定哪些」。 */
  providers: Array<{ id: string; name: string; fulfillmentTypes: string[] }>;
}

/** 运行期已注册的履约提供方。 */
function activeProviders(): FulfillmentProvider[] {
  return context().getExtensions<FulfillmentProvider>(EXTENSION_POINTS.fulfillmentProvider);
}

/**
 * 判定单个商品能否被交付。
 *
 * 与 `assertSellableProduct` 同源：那里抛错拦截下单，这里返回结构化原因给后台。
 */
export function diagnoseProduct(
  product: {
    id: string;
    name: string;
    status: string;
    fulfillmentType: string;
    providerId: string | null;
    providerProductId?: string | null;
  },
  providers: FulfillmentProvider[],
): SellabilityIssue | null {
  const base = {
    productId: product.id,
    name: product.name,
    fulfillmentType: product.fulfillmentType,
    providerId: product.providerId,
    providerProductId: product.providerProductId ?? null,
  };
  if (product.status !== 'ACTIVE') {
    return {
      ...base,
      code: 'INACTIVE',
      message: '商品已下架，买家看不到也无法下单。',
      blocking: false,
    };
  }
  // 云服务器必须绑定真实上游：本地类型插件只是防御性兜底，必定抛错。
  if (product.fulfillmentType === 'cloud_server') {
    if (!product.providerId) {
      return {
        ...base,
        code: 'NO_PROVIDER',
        message: '云服务器商品未绑定履约提供方，买家下单会被拒绝。请绑定上游插件或先下架。',
        blocking: true,
      };
    }
    const bound = providers.find((candidate) => candidate.id === product.providerId);
    if (!bound) {
      /*
       * "Rebind to another provider" is only useful advice when some active
       * provider can actually do cloud servers. On a fresh install none can, and
       * telling the operator to rebind sends them looking for a dropdown entry
       * that does not exist — the real fix is installing an upstream plugin or
       * delisting the product.
       */
      const alternative = providers.some((candidate) =>
        candidate.fulfillmentTypes.includes('cloud_server'),
      );
      return {
        ...base,
        code: 'PROVIDER_MISSING',
        message: alternative
          ? `绑定的履约提供方「${product.providerId}」未安装或未启用，买家下单会被拒绝。请安装并启用该插件，或改绑其他提供方。`
          : `绑定的履约提供方「${product.providerId}」未安装或未启用，且当前没有支持云服务器的履约提供方，买家下单会被拒绝。请安装上游插件，或先把商品下架。`,
        blocking: true,
      };
    }
    if (!bound.fulfillmentTypes.includes('cloud_server')) {
      return {
        ...base,
        code: 'PROVIDER_TYPE_UNSUPPORTED',
        message: `履约提供方「${bound.name}」不支持云服务器，买家下单会被拒绝。`,
        blocking: true,
      };
    }
    return null;
  }
  // 其他类型：providerId 绑了就必须存在，否则履约时会「未找到履约提供方」。
  if (product.providerId && !providers.some((candidate) => candidate.id === product.providerId)) {
    return {
      ...base,
      code: 'PROVIDER_MISSING',
      message: `绑定的履约提供方「${product.providerId}」未安装或未启用，付款后无法交付。`,
      blocking: true,
    };
  }
  return null;
}

/** 全量商品履约诊断（管理端）。 */
export async function listFulfillmentIssues(): Promise<FulfillmentDiagnostics> {
  const providers = activeProviders();
  const products = await listAllProducts();
  const issues = products.flatMap((product) => {
    const issue = diagnoseProduct(product, providers);
    return issue ? [issue] : [];
  });
  return {
    issues,
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      fulfillmentTypes: [...provider.fulfillmentTypes],
    })),
  };
}

/**
 * 确认某商品当前是否可交付（下单前置校验用）。
 *
 * 返回 `null` 表示可交付；否则返回阻断性原因。与 `providerForProduct` 的区别：
 * 后者只解析「用哪个提供方」，而云服务器的类型插件兜底虽然存在，但调用必失败。
 */
export function sellabilityBlocker(product: {
  status: string;
  fulfillmentType: string;
  providerId: string | null;
}): SellabilityIssue | null {
  const issue = diagnoseProduct(
    { id: '', name: '', ...product, providerProductId: null },
    activeProviders(),
  );
  return issue?.blocking ? issue : null;
}

export { providerForProduct };
