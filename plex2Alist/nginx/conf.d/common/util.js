import config from "../constant.js";

const ARGS = {
  plexTokenKey: "X-Plex-Token",
  internalKey: "internal",
  cacheLevleKey: "cacheLevel",
}

const ROUTE_ENUM = {
  proxy: "proxy",
  redirect: "redirect",
  block: "block",
};

const CHCHE_LEVEL_ENUM = {
  L1: "L1",
  L2: "L2",
  // L3: "L3",
};

const SOURCE_STR_ENUM = {
  filePath: "filePath",
  alistRes: "alistRes",
};

const MATCHER_ENUM = {
  startsWith: "startsWith",
  endsWith: "endsWith",
  includes: "includes",
  match: "match",
  not: "not",
};

// copy from emby2Alist/nginx/conf.d/util.js
function proxyUri(uri) {
  return `/proxy${uri}`;
}

function appendUrlArg(u, k, v) {
  if (u.includes(k)) {
    return u;
  }
  return u + (u.includes("?") ? "&" : "?") + `${k}=${v}`;
}

function getCurrentRequestUrlPrefix(r) {
  return `${r.variables.scheme}://${r.headersIn["Host"]}`;
}

function copyHeaders(sourceHeaders, targetHeaders, skipKeys) {
  if (!skipKeys) {
    // auto generate content length
    skipKeys = ["Content-Length"];
  }
  for (const key in sourceHeaders) {
	  if (skipKeys.includes(key)) {
	    continue;
	  }
	  targetHeaders[key] = sourceHeaders[key];
	}
}

/**
 * groupBy
 * @param {Array} array original > 1D array
 * @param {Number|Function} key groupBy key, Number is 1D array index, Function is custom key getter
 * @returns grouped Object Array, key is groupBy key(String), value is grouped 1D array
 */
function groupBy(array, key) {
  return array.reduce((result, currentItem) => {
    const groupKey = typeof key === 'function' ? key(currentItem) : currentItem[key];
    if (!result[groupKey]) {
      result[groupKey] = [];
    }
    result[groupKey].push(currentItem);
    return result;
  }, {});
};

/**
 * getRouteMode
 * @param {Object} r nginx objects, HTTP Request
 * @param {String} filePath mediaFilePath or alistRes link
 * @param {Boolean} isAlistRes alistRes link
 * @param {Boolean} notLocal if not need proxy route can be undefined
 * @returns ROUTE_ENUM.xxx
 */
function getRouteMode(r, filePath, isAlistRes, notLocal) {
  let cRouteRule = config.routeRule;
  // skip internal request
  if (r.args[ARGS.internalKey] === "1") {
    cRouteRule = cRouteRule.filter(rule => 
      rule[0] != "r.variables.remote_addr" 
      && rule[1] != "r.variables.remote_addr" 
      && rule[2] != "r.variables.remote_addr");
  }
  // old proxy, sigle rule length is 3 or 4(group)
  let proxyRules = cRouteRule.filter(rule => rule.length <= 4);
  // old proxy, validate rule[0] is ROUTE_ENUM
  proxyRules = proxyRules.filter(rule => !Object.keys(ROUTE_ENUM).includes(rule[0]));
  proxyRules = proxyRules.concat(cRouteRule
    .filter(rule => rule[0] === ROUTE_ENUM.proxy)
    // new proxy, remove routeMode
    .map(rule => rule.slice(1)));
  ngx.log(ngx.INFO, `getRouteMode proxyRules: ${JSON.stringify(proxyRules)}`);
  if (isProxy(r, proxyRules, filePath, isAlistRes, notLocal)) {
    return ROUTE_ENUM.proxy;
  }
  // new routeRules and not new proxy routeMode
  let routeRules = cRouteRule.filter(rule => {
    for (const rKey in ROUTE_ENUM) {
      if (ROUTE_ENUM[rKey] === rule[0] && rule[0] != ROUTE_ENUM.proxy) {
        return rule;
      }
    }
  });
  if (routeRules.length === 0 && isAlistRes) {
    // default value is redirect routeMode
    return ROUTE_ENUM.redirect;
  }
  // routeRules groupBy group name
  const routeRulesObjArr = groupBy(routeRules, 0);
  for (const rKey in routeRulesObjArr) {
    routeRules = routeRulesObjArr[rKey];
    // remove routeMode
    const oldRulesArr3D = routeRules.map(rRule => rRule.slice(1));
    // routeRules is 3D array
    if (routeRules[0].length > 4) {
      let matchedGroupKey = getMatchedRuleGroupKey(r, routeRules[0][1], oldRulesArr3D, filePath);
      if (matchedGroupKey) {
        ngx.log(ngx.WARN, `hit ${rKey}, group: ${matchedGroupKey}`);
        return rKey;
      }
    } else {
      const matchedRule = getMatchedRule(r, oldRulesArr3D, filePath);
      if (matchedRule) {
        ngx.log(ngx.WARN, `hit ${rKey}: ${JSON.stringify(matchedRule)}`);
        return rKey;
      }
    }
  }
  return ROUTE_ENUM.redirect;
}

/**
 * isProxy, old isDisableRedirectRule, one rule matched will return
 * sigle rule priority > group rule
 * @param {Object} r nginx objects, HTTP Request
 * @param {String} filePath mediaFilePath or alistRes link
 * @param {Boolean} isAlistRes alistRes link
 * @param {Boolean} notLocal if not need proxy route can be undefined
 * @returns Boolean
 */
function isProxy(r, proxyRules, filePath, isAlistRes, notLocal) {
  const disableRedirectRule = proxyRules;
  const mountPath = config.mediaMountPath;
  if (!isAlistRes) {
    // exact, local file not mediaMountPath first
    if (mountPath && mountPath.every(path => path && !filePath.startsWith(path) && !notLocal)) {
      ngx.log(ngx.WARN, `hit proxy, not mountPath first: ${JSON.stringify(mountPath)}`);
      return true;
    }
  }
  
  // old proxy, sigle rule length is 3 or 4(group)
  const oldRules = disableRedirectRule.filter(rule => rule.length <= 3);
  if (oldRules.length > 0) {
    let matchedRule = getMatchedRule(r, oldRules, filePath);
    if (matchedRule) {
      ngx.log(ngx.WARN, `hit proxy: ${JSON.stringify(matchedRule)}`);
      return true;
    }
  }
  // new proxy with group name
  const groupRulesObjArr = groupBy(disableRedirectRule.filter(rule => rule.length > 3), 0);
  if (Object.keys(groupRulesObjArr) === 0) {
    return false;
  }
  let matchedGroupKey;
  for (const gKey in groupRulesObjArr) {
    matchedGroupKey = getMatchedRuleGroupKey(r, gKey, groupRulesObjArr[gKey], filePath);
    if (matchedGroupKey) {
      ngx.log(ngx.WARN, `hit proxy, group: ${matchedGroupKey}`);
      return true;
    }
  }
  return false;
}

/**
 * getMatchedRuleGroupKey
 * @param {Object} r nginx objects, HTTP Request
 * @param {String} groupKey "115-alist"
 * @param {Array} groupRuleArr3D [["115-alist", "r.args.X-Emby-Client", 0, ["Emby Web", "Emby for iOS", "Infuse"]]]
 * @param {String} filePath mediaFilePath or alistRes link
 * @returns "115-alist"
 */
function getMatchedRuleGroupKey(r, groupKey, groupRuleArr3D, filePath) {
  let rvt;
  ngx.log(ngx.INFO, `getMatchedRuleGroupKey groupRuleArr3D: ${JSON.stringify(groupRuleArr3D)}`);
  // remove groupKey
  const ruleArr3D = groupRuleArr3D.map(gRule => gRule.slice(1));
  ngx.log(ngx.INFO, `getMatchedRuleGroupKey ruleArr3D: ${JSON.stringify(ruleArr3D)}`);
  // one group inner "every" is logical "and"
  if (ruleArr3D.every(rule => !!getMatchedRule(r, [rule], filePath))) {
    rvt = groupKey;
  }
  return rvt;
}

/**
 * getMatchedRule
 * @param {Object} r nginx objects, HTTP Request
 * @param {Array} ruleArr3D [["filePath", 3, /private/ig]]
 * @param {String} filePath mediaFilePath or alistRes link
 * @returns ["filePath", 3, /private/ig]
 */
function getMatchedRule(r, ruleArr3D, filePath) {
  return ruleArr3D.find(rule => {
    let sourceStr = filePath;
    if (!Object.values(SOURCE_STR_ENUM).includes(rule[0])) {
      sourceStr = parseExpression(r, rule[0]);
    }
    let flag = false;
    ngx.log(ngx.WARN, `sourceStrValue, ${rule[0]} = ${sourceStr}`);
    if (!sourceStr) {
      return flag;
    }
    const matcher = rule[2];
    if (Array.isArray(matcher) 
      && matcher.some(m => strMatches(rule[1], sourceStr, m))) {
      flag = true;
    } else {
      flag = strMatches(rule[1], sourceStr, matcher);
    }
    return flag;
  });
}

/**
 * parseExpression
 * @param {Object} rootObj like r
 * @param {String} expression like "r.args.MediaSourceId", notice skipped "r."
 * @param {String} propertySplit like "."
 * @param {String} groupSplit like ":"
 * @returns parsed string
 */
function parseExpression(rootObj, expression, propertySplit, groupSplit) {
  if (arguments.length < 4) {
    if (arguments.length < 3) {
      if (arguments.length < 2) {
        throw new Error("Missing required parameter: rootObj");
      }
      propertySplit = ".";
      groupSplit = ":";
    } else {
      groupSplit = propertySplit;
      propertySplit = ".";
    }
  }

  if (typeof rootObj !== "object" || rootObj === null) {
    throw new Error("rootObj must be a non-null object");
  }
  
  if (typeof expression !== "string" || expression.trim() === "") {
    return undefined;
  }

  if (typeof propertySplit !== "string" || typeof groupSplit !== "string") {
    throw new Error("Property and group split must be strings");
  }

  const expGroups = expression.split(groupSplit);
  let values = [];

  expGroups.map(expGroup => {
    if (!expGroup.trim()) return;

    const expArr = expGroup.split(propertySplit);
    let val = rootObj;

    // skipped index 0
    expArr.map((expPart, index) => {
      if (index === 0) return;
      if (val && Object.hasOwnProperty.call(val, expPart)) {
        val = val[expPart];
      } else {
        val = "";
        ngx.log(ngx.INFO, `Property "${expPart}" not found in object,will ignore`);
      }
    });

    values.push(val);
  });

  return values.filter(item => item).join(groupSplit);
}

function strMapping(type, sourceValue, searchValue, replaceValue) {
  let str = sourceValue;
  if (type == 0) {
    str = str.replace(searchValue, replaceValue);
    ngx.log(ngx.WARN, `strMapping replace: ${searchValue} => ${replaceValue}`);
  } else if (type == 1) {
    str = searchValue + str;
    ngx.log(ngx.WARN, `strMapping append: ${searchValue}`);
  } else if (type == 2) {
    str += searchValue;
    ngx.log(ngx.WARN, `strMapping unshift: ${searchValue}`);
  } else if (type == 3) {
    str = str.replaceAll(searchValue, replaceValue);
    ngx.log(ngx.WARN, `strMapping replaceAll: ${searchValue} => ${replaceValue}`);
  }
  return str;
}

/**
 * strMatches
 * @param {Number|String} type 0: startsWith(str), 1: endsWith(str), 2: includes(str), 3: match(/ain/g)
 * @param {String} searchValue
 * @param {String|RegExp} matcher
 * @returns boolean
 */
function strMatches(type, searchValue, matcher) {
  let flag = false;
  // old
  if (Number.isInteger(type)) {
    if (type === 0) {
      flag =  searchValue.startsWith(matcher);
    } else if (type === 1) {
      flag =  searchValue.endsWith(matcher);
    } else if (type === 2) {
      flag =  searchValue.includes(matcher);
    } else if (type === 3) {
      flag =  !!searchValue.match(matcher);
    }
    return flag;
  }
  // new
  if (typeof type == "string") {
    const parts = type.split(":");
    const typeStr = parts[0];
    const negateStr = parts[1];

    if (typeStr == MATCHER_ENUM.startsWith) {
      flag = searchValue.startsWith(matcher);
    } else if (typeStr == MATCHER_ENUM.endsWith) {
      flag = searchValue.endsWith(matcher);
    } else if (typeStr == MATCHER_ENUM.includes) {
      flag = searchValue.includes(matcher);
    } else if (typeStr == MATCHER_ENUM.match) {
      flag = !!searchValue.match(matcher);
    } else {
      throw new Error("Unknown type: " + typeStr);
    }

    return negateStr == MATCHER_ENUM.not ? !flag : flag;
  }

  throw new Error("Invalid type provided");
}

function checkIsStrmByPath(filePath) {
  if (!!filePath) {
    // strm: filePath1-itemPath like: /xxx/xxx.strm
    return filePath.toLowerCase().endsWith(".strm");
  }
  return false;
}

function isAbsolutePath(filePath) {
  return filePath && typeof filePath === "string" 
    ? filePath.startsWith("/") || filePath.startsWith("\\") : false;
}

/**
 * simpleRuleFilter
 * 1.support old rule, index 0: match, index 1: matchTarget
 * 2.support new rule, index 0: matchSource, index 1: match, index 2: matchTarget
 * 3.support new rule, index 0: groupName, index 1: matchSource, index 2: match, index 3: matchTarget
 * @param {Object} r nginx objects, HTTP Request
 * @param {Array}  ruleArr3D support group rule
 * @param {String} filePath mediaFilePath or alistRes raw_url
 * @param {String} firstSourceStr SOURCE_STR_ENUM String
 * @param {String} mark log and tip keyword
 * @returns undefined | matchedRule: old rule is single, group return first rule
 */
function simpleRuleFilter(r, ruleArr3D, filePath, firstSourceStr, mark) {
  if (!firstSourceStr) {
    firstSourceStr = SOURCE_STR_ENUM.filePath;
  }
  if (!mark) {
    mark = "simpleRule";
  }
  // group current rules, old is true, new is false
  const onGroupRulesObjArr = groupBy(ruleArr3D, 
    rule => Number.isInteger(rule[0]) || Object.values(MATCHER_ENUM).includes(rule[0])
  );
  let onGroupItemRules;
  let paramRulesArr3D;
  for (const onKey in onGroupRulesObjArr) {
    ngx.log(ngx.INFO, `${mark}Filter onKey: ${onKey}, typeof: ${typeof onKey}`);
    onGroupItemRules = onGroupRulesObjArr[onKey];
    if (onKey === "true") {
      // convert params, old rules default add index 0
      paramRulesArr3D = onGroupItemRules.map(rRule => {
        const copy = rRule.slice();
        copy.unshift(firstSourceStr);
        return copy;
      });
      let matchedRule = getMatchedRule(r, paramRulesArr3D, filePath);
      if (matchedRule) {
        matchedRule = Object.values(SOURCE_STR_ENUM).includes(matchedRule[0]) ? matchedRule.slice(1) : matchedRule;
        ngx.log(ngx.WARN, `hit ${mark}: ${JSON.stringify(matchedRule)}`);
        return matchedRule;
      }
    } else {
      const keyGroupRulesObjArr = groupBy(onGroupItemRules, 0);
      if (Object.keys(keyGroupRulesObjArr).length === 0) {
        return;
      }
      for (const kgKey in keyGroupRulesObjArr) {
        ngx.log(ngx.INFO, `${mark}Filter kgKey: ${kgKey}`);
        paramRulesArr3D = keyGroupRulesObjArr[kgKey];
        const matchedGroupKey = getMatchedRuleGroupKey(r, kgKey, paramRulesArr3D, filePath);
        if (matchedGroupKey) {
          ngx.log(ngx.WARN, `hit ${mark} group: ${matchedGroupKey}`);
          return paramRulesArr3D.find(gRule => gRule[0] === matchedGroupKey);
        }
      }
    }
  }
}

function getClientSelfAlistLink(r, filePath, alistFilePath) {
  let rule = simpleRuleFilter(r, config.clientSelfAlistRule, filePath, SOURCE_STR_ENUM.alistRes, "clientSelfAlistRule");
  if (rule && rule.length > 0) {
    if (!Number.isInteger(rule[0])) {
      // convert groupRule remove groupKey and sourceValue
      r.warn(`convert groupRule remove groupKey and sourceValue`);
      rule = rule.slice(2);
    }
    const alistPublicAddr = rule.length === 3 ? rule[2] : config.alistPublicAddr;
    //  @param {String} filePath mediaFilePath or alistRes link
    return `${alistPublicAddr}/d${encodeURI(alistFilePath || filePath)}`;
  }
}

/**
 * dictAdd, ngx.shared.SharedDict.add(key, value [,timeout])
 * @since NJS 0.8.0
 * @param {String} dictName 
 * @param {String} key 
 * @param {String|Number} value default is String, js_shared_dict_zone type=number
 * @param {Number} timeout milliseconds,since NJS 0.8.5
 * @returns Number "fail" -1: fail, 0: not expire, "success" 1: added, 2: added with timeout
 */
function dictAdd(dictName, key, value, timeout) {
  if (!dictName || !key || !value) return 0;

  const dict = ngx.shared[dictName];
  const preValue = dict.get(key);
  if (preValue === value) return 0;

  const msgBase = `${dictName} add: [${key}] : [${value}]`;
  // simple version string compare use Unicode, better use njs.version_number
  if (njs.version >= "0.8.5" && timeout > 0) {
    if (dict.add(key, value, timeout)) {
      ngx.log(ngx.WARN, `${msgBase}, timeout: ${timeout}ms`);
      return 2;
    }
  } else {
    if (dict.add(key, value)) {
      ngx.log(ngx.WARN, `${msgBase}${timeout ? `, skip arguments: timeout: ${timeout}ms` : ''}`);
      return 1;
    }
  }
  return 0;
}

async function cost(func) {
  if (!func || !(func instanceof Function)) {
    ngx.log(ngx.ERR, `target function not null or is not function`);
    return;
  }
  const args = Array.prototype.slice.call(arguments, 1);
  const start = Date.now();
  let rvt;
  try {
    rvt = func.apply(func, args);
    if (rvt instanceof Promise) {
      await rvt.then(
        realRvt => {
          const end = Date.now();
          ngx.log(ngx.WARN, `${end - start}ms, ${func.name} async function cost`);
          // return realRvt;
        },
        error => {
          const end = Date.now();
          ngx.log(ngx.ERR, `${end - start}ms, ${func.name} async function throw an error`);
          throw error;
        }
      );
    } else {
      const end = Date.now();
      ngx.log(ngx.WARN, `${end - start}ms, ${func.name} function cost`);
    }
  } catch (error) {
    const end = Date.now();
    ngx.log(ngx.ERR, `${end - start}ms, ${func.name} sync function throw an error`);
    throw error;
  }
  return rvt;
}

/**
 * 1.CloudDrive
 * http://mydomain:19798/static/http/mydomain:19798/False//AList/xxx.mkv
 * 2.AList
 * http://mydomain:5244/d/AList/xxx.mkv
 * see: https://regex101.com/r/Gd3JUH/1
 * @param {String} url full url
 * @returns "/AList/xxx.mkv" or "AList/xxx.mkv" or ""
 */
function getFilePathPart(url) {
  const matches = url.match(/(?:\/False\/|\/d\/)(.*)/g);
  return matches ? matches[1] : "";
}

/**
 * Parses the URL and returns an object with various components.
 * @param {string} url The URL string to parse.
 * @returns {Object} An object containing protocol, username, password, host, port, pathname, search, and hash.
 */
function parseUrl(url) {
  const regex = /^(?:(\w+)?:\/\/)?(?:(\w+):(\w+)@)?(?:www\.)?([^:\/\n?#]+)(?::(\d+))?(\/[^?\n]*)?(\?[^#\n]*)?(#.*)?$/i;
  const match = url.match(regex);
  if (match) {
      const protocol = match[1] || 'http';
      const username = match[2] || '';
      const password = match[3] || '';
      const host = match[4];
      const port = match[5] || '';
      const pathname = match[6] || '';
      const search = match[7] || '';
      const hash = match[8] || '';
      const fullProtocol = `${protocol}:`;
      const fullPort = port || (fullProtocol === 'https:' ? '443' : '80');
      return {
          protocol: fullProtocol,
          username,
          password,
          host,
          port: fullPort,
          pathname,
          search,
          hash
      };
  }
  return null;
}

/**
 * Crypto
 */
const crypto = require('crypto');

function calculateHMAC(data, key) {
  // 创建 HMAC 对象，并指定算法和密钥
  const hmac = crypto.createHmac('sha256', key);
  // 更新要计算的数据
  hmac.update(data);
  // 计算摘要并以 GoLang 中 URLEncoding 方式返回
  return hmac.digest('base64')
      .replaceAll("+", "-")
      .replaceAll("/", "_");
}

function addAlistSign(url, alistToken, alistSignExpireTime) {
  let path = url.match(/https?:\/\/[^\/]+(\/[^?#]*)/)[1]
  const startIndex = path.indexOf("/d/")
  if (url.indexOf("sign=") === -1 && startIndex !== -1) {
    // add sign param for alist
    if (url.indexOf("?") === -1) {
      url += "?"
    } else {
      url += "&"
    }
    const expiredHour = alistSignExpireTime ?? 0
    let time = 0;
    if (expiredHour !== 0) {
      time = Math.floor(Date.now() / 1000 + expiredHour * 3600)
    }
    path = decodeURIComponent(path.substring(startIndex + 2).replaceAll('//','/'))
    const signData = `${path}:${time}`
    ngx.log(ngx.WARN, `sign data: ${signData}`)
    const sign = calculateHMAC(signData, alistToken)
    url = `${url}sign=${sign}:${time}`
  }
  return url;
}

/**
 * File System
 */
const fs = require("fs");

function checkAndGetRealpathSync(path) {
  try {
    // this only check SymbolicLink file read permission, not target file
    fs.accessSync(path, fs.constants.R_OK);
    let symStats = fs.lstatSync(path);
    if (!symStats) throw new Error(`symStats is null`);
    // if (!symStats.isFile()) throw new Error(`not a file`);
    if (symStats.nlink > 1) throw new Error(`this is hard-link`);
    if (!symStats.isSymbolicLink()) throw new Error(`not isSymbolicLink`);
    return fs.realpathSync(path);
  } catch (e) {
    ngx.log(ngx.WARN, `${e}, skip: ${path}`);
  }
}

// plex only
function getFileNameByHead(contentDisposition) {
  if (contentDisposition && contentDisposition.length > 0) {
    const regex = /filename[^;\n]*=(UTF-\d['"]*)?((['"]).*?[.]$\2|[^;\n]*)?/gi;
    return contentDisposition.match(regex)[1].replace("filename*=UTF-8''", "");
  }
  return null;
}

export default {
  ARGS,
  ROUTE_ENUM,
  CHCHE_LEVEL_ENUM,
  SOURCE_STR_ENUM,
  proxyUri,
  appendUrlArg,
  getCurrentRequestUrlPrefix,
  copyHeaders,
  strMapping,
  strMatches,
  getRouteMode,
  parseExpression,
  checkIsStrmByPath,
  isAbsolutePath,
  simpleRuleFilter,
  getClientSelfAlistLink,
  dictAdd,
  cost,
  getFilePathPart,
  parseUrl,
  calculateHMAC,
  addAlistSign,
  checkAndGetRealpathSync,
  getFileNameByHead,
};
